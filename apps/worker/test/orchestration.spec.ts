import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkersAiTemporaryFailure } from "../src/ai/workers-ai";
import { Repository } from "../src/db/repository";
import type { Candidate, SourceComment, SourceItem } from "../src/domain";
import { createWorker, PIPELINE_MAX_RETRIES, RUN_STALE_AFTER_MS } from "../src/index";
import {
  RedditAccessDenied,
  RedditRateLimited,
  RedditTemporaryFailure,
  RedditUnexpectedResponse,
} from "../src/reddit/anonymous-json";
import { applyMigrations } from "./apply-migrations";

const now = new Date("2026-07-24T00:30:00.000Z");
const summaryLeaseSeconds = 10 * 60;

function item(id = "t3_post1"): SourceItem {
  return {
    id,
    source: "reddit",
    externalId: id,
    title: "Useful source item",
    author: "author",
    redditUrl: `https://reddit.com/r/todayilearned/comments/${id.slice(3)}`,
    sourceUrl: `https://example.test/source/${id}`,
    score: 100,
    upvoteRatio: 0.9,
    commentCount: 10,
    publishedAt: "2026-07-24T00:00:00.000Z",
    fetchedAt: now.toISOString(),
    lastCheckedAt: now.toISOString(),
    deletedAt: null,
  };
}

function comment(itemId: string): SourceComment {
  return {
    id: `t1_${itemId.slice(3)}`,
    itemId,
    externalId: `t1_${itemId.slice(3)}`,
    parentExternalId: itemId,
    author: "commenter",
    body: "This is a useful comment with enough detail to retain.",
    score: 10,
    depth: 0,
    redditUrl: "https://reddit.com/comment",
    publishedAt: now.toISOString(),
    fetchedAt: now.toISOString(),
    deletedAt: null,
    deleted: false,
  };
}

function candidate(runId: string, itemId: string, status: Candidate["status"] = "selected"): Candidate {
  return {
    id: `${runId}:${itemId}`,
    runId,
    itemId,
    score: 100,
    reasons: ["popular"],
    rank: 1,
    status,
    selectedAt: now.toISOString(),
  };
}

function knowledgeCard() {
  return {
    decision: "publish" as const,
    decisionReason: "内容具体且评论提供了信息增量。",
    titleZh: "中文标题",
    oneLineFact: "原帖声称一件值得了解的事。",
    whyInteresting: "这件事提供了一个有趣的视角。",
    commentInsights: [{ text: "评论补充了背景。", commentIndex: 0 }],
    caveats: ["尚未进行外部事实核查。"],
    confidenceNote: "内容仅基于原帖和评论。",
  };
}

function queue(sendImplementation: (message: unknown) => Promise<void> = async () => undefined) {
  const send = vi.fn(sendImplementation);
  return { send };
}

function message(
  body: { stage: "discover"; runId: string } | { stage: "comments" | "summarize"; runId: string; itemId: string },
  attempts = 1,
) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function clearDatabase(): Promise<void> {
  await env.DB.batch(
    ["review_actions", "regeneration_requests", "summaries", "candidates", "source_comments", "source_items", "fetch_runs", "settings"]
      .map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
}

function reddit(overrides: Partial<{
  listTopPosts: () => Promise<SourceItem[]>;
  getPostWithComments: (itemId: string) => Promise<{ item: SourceItem; comments: SourceComment[] }>;
}> = {}) {
  return {
    listTopPosts: vi.fn(overrides.listTopPosts ?? (async () => [item()])),
    getPostWithComments: vi.fn(overrides.getPostWithComments ?? (async (itemId: string) => ({ item: item(itemId), comments: [comment(itemId)] }))),
    checkItems: vi.fn(async () => []),
    checkComments: vi.fn(async () => []),
  };
}

function environment(pipeline: ReturnType<typeof queue>) {
  return { ...env, PIPELINE: pipeline, REDDIT_USER_AGENT: "everyday-news-test" };
}

describe("pipeline orchestration", () => {
  let repository: Repository;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await applyMigrations();
    await clearDatabase();
    repository = new Repository(env.DB);
  });

  it("creates one Shanghai-local daily run and reuses it for a duplicate schedule", async () => {
    const pipeline = queue();
    const worker = createWorker({ reddit: reddit(), now: () => now });

    await worker.scheduled?.({} as ScheduledEvent, environment(pipeline) as never, {} as ExecutionContext);
    await worker.scheduled?.({} as ScheduledEvent, environment(pipeline) as never, {} as ExecutionContext);

    const run = await repository.getRunByLocalDate("2026-07-24");
    expect(run).toMatchObject({ localDate: "2026-07-24", status: "running" });
    expect(pipeline.send).toHaveBeenCalledTimes(1);
    expect(pipeline.send).toHaveBeenCalledWith({ stage: "discover", runId: run?.id });
  });

  it("expires a stale same-day attempt before scheduling a replacement", async () => {
    await repository.createRun({
      id: "stale-run",
      localDate: "2026-07-24",
      startedAt: new Date(now.getTime() - RUN_STALE_AFTER_MS - 1).toISOString(),
    });
    await repository.markRunRunning("stale-run");
    const pipeline = queue();
    const worker = createWorker({ reddit: reddit(), now: () => now });

    await worker.scheduled?.({} as ScheduledEvent, environment(pipeline) as never, {} as ExecutionContext);

    const runs = await repository.listRuns("2026-07-24");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ status: "running" });
    expect(runs[1]).toMatchObject({
      id: "stale-run",
      status: "failed",
      errorCode: "run_timed_out",
    });
  });

  it("re-enqueues a same-date queued run after schedule delivery fails", async () => {
    let rejectDelivery = true;
    const pipeline = queue(async () => {
      if (rejectDelivery) throw new Error("queue unavailable");
    });
    const worker = createWorker({ reddit: reddit(), now: () => now });

    await expect(
      worker.scheduled?.({} as ScheduledEvent, environment(pipeline) as never, {} as ExecutionContext),
    ).rejects.toThrow("queue unavailable");
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: "queued" });

    rejectDelivery = false;
    await worker.scheduled?.({} as ScheduledEvent, environment(pipeline) as never, {} as ExecutionContext);
    await worker.scheduled?.({} as ScheduledEvent, environment(pipeline) as never, {} as ExecutionContext);

    expect(pipeline.send).toHaveBeenCalledTimes(2);
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: "running" });
  });

  it("fans discovery out to one comments message per selected item", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const worker = createWorker({ reddit: reddit({ listTopPosts: async () => [item("t3_one"), item("t3_two")] }), now: () => now });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(pipeline.send).toHaveBeenCalledWith(
      { stage: "comments", runId: run.id, itemId: "t3_one" },
      { delaySeconds: 75 },
    );
    expect(pipeline.send).toHaveBeenCalledWith(
      { stage: "comments", runId: run.id, itemId: "t3_two" },
      { delaySeconds: 150 },
    );
  });

  it("emits safe structured events at successful stage boundaries", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-24",
      startedAt: now.toISOString(),
    });
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const worker = createWorker({ reddit: reddit(), now: () => now });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.(
      { messages: [queued] } as MessageBatch<never>,
      environment(pipeline) as never,
      {} as ExecutionContext,
    );

    expect(logged).toHaveBeenCalledWith({
      event: "pipeline_stage_boundary",
      runId: run.id,
      stage: "discover",
      attempt: 1,
      category: "stage",
      decision: "started",
    });
    expect(logged).toHaveBeenCalledWith({
      event: "pipeline_stage_boundary",
      runId: run.id,
      stage: "discover",
      attempt: 1,
      category: "stage",
      decision: "completed",
    });
  });

  it("replays every discovery fan-out message after a partial queue delivery", async () => {
    let delivery = 0;
    const pipeline = queue(async () => {
      delivery += 1;
      if (delivery === 2) throw new Error("queue unavailable");
    });
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const redditAdapter = reddit({ listTopPosts: async () => [item("t3_one"), item("t3_two")] });
    const worker = createWorker({ reddit: redditAdapter, now: () => now });
    const first = message({ stage: "discover", runId: run.id });
    const replay = message({ stage: "discover", runId: run.id });

    await worker.queue?.({ messages: [first] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);
    await worker.queue?.({ messages: [replay] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(redditAdapter.listTopPosts).toHaveBeenCalledOnce();
    expect(pipeline.send.mock.calls.map(([body]) => body)).toEqual([
      { stage: "comments", runId: run.id, itemId: "t3_one" },
      { stage: "comments", runId: run.id, itemId: "t3_two" },
      { stage: "comments", runId: run.id, itemId: "t3_one" },
      { stage: "comments", runId: run.id, itemId: "t3_two" },
    ]);
  });

  it("enqueues summarization after successfully collecting comments", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item());
    await repository.saveCandidate(candidate(run.id, "t3_post1"));
    const worker = createWorker({ reddit: reddit(), now: () => now });
    const queued = message({ stage: "comments", runId: run.id, itemId: "t3_post1" });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(pipeline.send).toHaveBeenCalledWith({ stage: "summarize", runId: run.id, itemId: "t3_post1" });
    expect(await repository.getCandidate(run.id, "t3_post1")).toMatchObject({ status: "comments_ready" });
  });

  it("replays summarize delivery from comments_ready without replacing comments again", async () => {
    let rejectDelivery = true;
    const pipeline = queue(async () => {
      if (rejectDelivery) throw new Error("queue unavailable");
    });
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item());
    await repository.saveCandidate(candidate(run.id, "t3_post1"));
    const redditAdapter = reddit();
    const replaceComments = vi.spyOn(Repository.prototype, "replaceComments");
    const worker = createWorker({ reddit: redditAdapter, now: () => now });
    const first = message({ stage: "comments", runId: run.id, itemId: "t3_post1" });
    const replay = message({ stage: "comments", runId: run.id, itemId: "t3_post1" });

    await worker.queue?.({ messages: [first] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);
    rejectDelivery = false;
    await worker.queue?.({ messages: [replay] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(redditAdapter.getPostWithComments).toHaveBeenCalledOnce();
    expect(replaceComments).toHaveBeenCalledOnce();
    expect(pipeline.send).toHaveBeenCalledTimes(2);
  });

  it("recovers a comments_ready summarize delivery after a sibling fails the run", async () => {
    let rejectDelivery = true;
    const pipeline = queue(async () => {
      if (rejectDelivery) throw new Error("queue unavailable");
    });
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item("t3_recover"));
    await repository.upsertSourceItem(item("t3_denied"));
    await repository.saveCandidate(candidate(run.id, "t3_recover", "comments_ready"));
    await repository.saveCandidate({
      ...candidate(run.id, "t3_denied"),
      id: `${run.id}:t3_denied`,
      itemId: "t3_denied",
      rank: 2,
    });
    const redditAdapter = reddit({
      getPostWithComments: async (itemId) => {
        if (itemId === "t3_denied") throw new RedditAccessDenied(403);
        return { item: item(itemId), comments: [comment(itemId)] };
      },
    });
    const worker = createWorker({ reddit: redditAdapter, now: () => now });
    const denied = message({ stage: "comments", runId: run.id, itemId: "t3_denied" });
    await worker.queue?.(
      { messages: [denied] } as MessageBatch<never>,
      environment(pipeline) as never,
      {} as ExecutionContext,
    );
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({
      status: "queued",
      errorCode: null,
    });

    pipeline.send.mockClear();
    redditAdapter.getPostWithComments.mockClear();
    const interruptedReplay = message({ stage: "comments", runId: run.id, itemId: "t3_recover" });
    await worker.queue?.(
      { messages: [interruptedReplay] } as MessageBatch<never>,
      environment(pipeline) as never,
      {} as ExecutionContext,
    );

    expect(redditAdapter.getPostWithComments).not.toHaveBeenCalled();
    expect(pipeline.send).toHaveBeenCalledOnce();
    expect(pipeline.send).toHaveBeenCalledWith({
      stage: "summarize",
      runId: run.id,
      itemId: "t3_recover",
    });
    expect(interruptedReplay.retry).toHaveBeenCalledOnce();
    expect(interruptedReplay.ack).not.toHaveBeenCalled();

    rejectDelivery = false;
    pipeline.send.mockClear();
    const recoveredReplay = message({ stage: "comments", runId: run.id, itemId: "t3_recover" });
    await worker.queue?.(
      { messages: [recoveredReplay] } as MessageBatch<never>,
      environment(pipeline) as never,
      {} as ExecutionContext,
    );

    expect(redditAdapter.getPostWithComments).not.toHaveBeenCalled();
    expect(pipeline.send).toHaveBeenCalledOnce();
    expect(pipeline.send).toHaveBeenCalledWith({
      stage: "summarize",
      runId: run.id,
      itemId: "t3_recover",
    });
    expect(recoveredReplay.ack).toHaveBeenCalledOnce();
    expect(recoveredReplay.retry).not.toHaveBeenCalled();
  });

  it("delays a fresh summary-claim retry until the lease can expire, then reclaims and completes", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item());
    await repository.saveCandidate(candidate(run.id, "t3_post1", "comments_ready"));
    await repository.replaceComments("t3_post1", [comment("t3_post1")]);
    await repository.completeDiscovery(run.id, { discovered: 1, selected: 1 }, now.toISOString());
    await repository.claimCandidateForSummary(
      `${run.id}:t3_post1`,
      "fresh-owner",
      now.toISOString(),
      new Date(now.getTime() - summaryLeaseSeconds * 1_000).toISOString(),
    );
    let current = now;
    const generator = { generate: vi.fn(async () => knowledgeCard()) };
    const worker = createWorker({ reddit: reddit(), generator, now: () => current });
    const first = message({ stage: "summarize", runId: run.id, itemId: "t3_post1" });

    await worker.queue?.({ messages: [first] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: summaryLeaseSeconds });
    expect(first.ack).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();

    current = new Date(now.getTime() + summaryLeaseSeconds * 1_000);
    const later = message({ stage: "summarize", runId: run.id, itemId: "t3_post1" });
    await worker.queue?.({ messages: [later] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(later.ack).toHaveBeenCalledOnce();
    expect(later.retry).not.toHaveBeenCalled();
    expect(generator.generate).toHaveBeenCalledOnce();
    expect(await repository.getCandidate(run.id, "t3_post1")).toMatchObject({ status: "summarized" });
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: "completed" });
  });

  it.each([
    ["summarized", "completed"],
    ["failed", "failed"],
  ] as const)("refreshes a run from a replayed %s summary message", async (candidateStatus, runStatus) => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item());
    await repository.saveCandidate(candidate(run.id, "t3_post1", candidateStatus));
    await repository.completeDiscovery(run.id, { discovered: 1, selected: 1 }, now.toISOString());
    const worker = createWorker({ reddit: reddit(), now: () => now });
    const queued = message({ stage: "summarize", runId: run.id, itemId: "t3_post1" });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: runStatus });
  });

  it("preserves an existing partial run when a completed summary message is replayed", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item());
    await repository.saveCandidate(candidate(run.id, "t3_post1", "summarized"));
    await repository.completeDiscovery(run.id, { discovered: 1, selected: 1 }, now.toISOString());
    await repository.markRunPartial(run.id, "earlier_failure", "Earlier stage failed", now.toISOString());
    const worker = createWorker({ reddit: reddit(), now: () => now });
    const queued = message({ stage: "summarize", runId: run.id, itemId: "t3_post1" });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({
      status: "partial",
      errorCode: "earlier_failure",
    });
  });

  it("retries a terminal refresh failure without mutating the summarized candidate, then completes", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item());
    await repository.saveCandidate(candidate(run.id, "t3_post1", "summarized"));
    await repository.completeDiscovery(run.id, { discovered: 1, selected: 1 }, now.toISOString());
    vi.spyOn(Repository.prototype, "refreshRunStatus").mockRejectedValueOnce(new Error("D1 unavailable"));
    const worker = createWorker({ reddit: reddit(), now: () => now });
    const first = message({ stage: "summarize", runId: run.id, itemId: "t3_post1" });
    const later = message({ stage: "summarize", runId: run.id, itemId: "t3_post1" });

    await worker.queue?.({ messages: [first] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(await repository.getCandidate(run.id, "t3_post1")).toMatchObject({ status: "summarized" });

    await worker.queue?.({ messages: [later] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(later.ack).toHaveBeenCalledOnce();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: "completed" });
  });

  it("acknowledges completed stage messages without repeating stage writes", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item());
    await repository.saveCandidate(candidate(run.id, "t3_post1", "summarized"));
    const redditAdapter = reddit();
    const worker = createWorker({ reddit: redditAdapter, now: () => now });
    const comments = message({ stage: "comments", runId: run.id, itemId: "t3_post1" });
    const summarize = message({ stage: "summarize", runId: run.id, itemId: "t3_post1" });

    await worker.queue?.({ messages: [comments, summarize] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(comments.ack).toHaveBeenCalledOnce();
    expect(summarize.ack).toHaveBeenCalledOnce();
    expect(redditAdapter.getPostWithComments).not.toHaveBeenCalled();
    expect(pipeline.send).not.toHaveBeenCalled();
  });

  it("marks a partially failed batch partial instead of completed", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item("t3_good"));
    await repository.upsertSourceItem(item("t3_bad"));
    await repository.saveCandidate(candidate(run.id, "t3_good"));
    await repository.saveCandidate({ ...candidate(run.id, "t3_bad"), id: `${run.id}:t3_bad`, itemId: "t3_bad", rank: 2 });
    const worker = createWorker({
      reddit: reddit({
        getPostWithComments: async (itemId) => {
          if (itemId === "t3_bad") throw new RedditUnexpectedResponse("bad response");
          return { item: item(itemId), comments: [comment(itemId)] };
        },
      }),
      now: () => now,
    });
    const good = message({ stage: "comments", runId: run.id, itemId: "t3_good" });
    const bad = message({ stage: "comments", runId: run.id, itemId: "t3_bad" });

    await worker.queue?.({ messages: [good, bad] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(good.ack).toHaveBeenCalledOnce();
    expect(bad.ack).toHaveBeenCalledOnce();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: "partial" });
  });

  it.each([
    [1, 30],
    [2, 60],
  ])("retries Reddit temporary failures with exponential delay on attempt %i", async (attempts, delaySeconds) => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const failure = new RedditTemporaryFailure("Reddit unavailable");
    const worker = createWorker({ reddit: reddit({ listTopPosts: async () => { throw failure; } }), now: () => now });
    const queued = message({ stage: "discover", runId: run.id }, attempts);

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds });
    expect(queued.ack).not.toHaveBeenCalled();
  });

  it.each([
    [0, 60],
    [120, 120],
    [600, 300],
  ])("retries Reddit rate limits with a bounded delay (%is -> %is)", async (retryAfter, delaySeconds) => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-24",
      startedAt: now.toISOString(),
    });
    const worker = createWorker({
      reddit: reddit({
        listTopPosts: async () => {
          throw new RedditRateLimited(retryAfter);
        },
      }),
      now: () => now,
    });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.(
      { messages: [queued] } as MessageBatch<never>,
      environment(pipeline) as never,
      {} as ExecutionContext,
    );

    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds });
    expect(queued.ack).not.toHaveBeenCalled();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({
      status: "running",
      errorCode: null,
    });
  });

  it("marks the run failed instead of retrying after the final delivery", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-24",
      startedAt: now.toISOString(),
    });
    const queued = message(
      { stage: "discover", runId: run.id },
      PIPELINE_MAX_RETRIES + 1,
    );
    const worker = createWorker({
      reddit: reddit({
        listTopPosts: async () => {
          throw new RedditTemporaryFailure("Reddit unavailable");
        },
      }),
      now: () => now,
    });

    await worker.queue?.(
      { messages: [queued] } as MessageBatch<never>,
      environment(pipeline) as never,
      {} as ExecutionContext,
    );

    expect(queued.retry).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({
      status: "failed",
      errorCode: "pipeline_discover_retries_exhausted",
      finishedAt: now.toISOString(),
    });
  });

  it("retries an exception that escapes per-message recovery", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queued = {
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    } as Record<string, unknown>;
    Object.defineProperty(queued, "body", {
      get() {
        throw new Error("corrupt queue envelope");
      },
    });
    const worker = createWorker({ now: () => now });

    await worker.queue?.(
      { messages: [queued] } as MessageBatch<never>,
      environment(queue()) as never,
      {} as ExecutionContext,
    );

    expect(queued.retry).toHaveBeenCalledOnce();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith({
      event: "pipeline_delivery_failed",
      attempt: 1,
      decision: "retry",
      category: "invalid_queue_envelope",
    });
  });

  it("preserves the default retry behavior for Workers AI temporary failures", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const generator = {
      generate: vi.fn(async () => {
        throw new WorkersAiTemporaryFailure("AI unavailable");
      }),
    };
    await repository.upsertSourceItem(item());
    await repository.replaceComments("t3_post1", [comment("t3_post1")]);
    await repository.saveCandidate(candidate(run.id, "t3_post1", "comments_ready"));
    const worker = createWorker({ reddit: reddit(), generator, now: () => now });
    const queued = message({ stage: "summarize", runId: run.id, itemId: "t3_post1" });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.retry).toHaveBeenCalledWith();
    expect(queued.ack).not.toHaveBeenCalled();
  });

  it("stops a replayed discover stage after the run records Reddit access denial", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const redditAdapter = reddit({
      listTopPosts: async () => {
        throw new RedditAccessDenied(403);
      },
    });
    const worker = createWorker({ reddit: redditAdapter, now: () => now });
    const denied = message({ stage: "discover", runId: run.id });
    const replay = message({ stage: "discover", runId: run.id });

    await worker.queue?.(
      { messages: [denied, replay] } as MessageBatch<never>,
      environment(pipeline) as never,
      {} as ExecutionContext,
    );

    expect(redditAdapter.listTopPosts).toHaveBeenCalledOnce();
    expect(denied.ack).toHaveBeenCalledOnce();
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(pipeline.send).not.toHaveBeenCalled();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({
      status: "failed",
      errorCode: "forbidden",
    });
  });

  it("continues sibling comment stages after one RSS candidate is denied", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    await repository.upsertSourceItem(item("t3_denied"));
    await repository.upsertSourceItem(item("t3_sibling"));
    await repository.saveCandidate(candidate(run.id, "t3_denied"));
    await repository.saveCandidate({
      ...candidate(run.id, "t3_sibling"),
      id: `${run.id}:t3_sibling`,
      itemId: "t3_sibling",
      rank: 2,
    });
    const redditAdapter = reddit({
      getPostWithComments: async (itemId) => {
        if (itemId === "t3_denied") throw new RedditAccessDenied(403);
        return { item: item(itemId), comments: [comment(itemId)] };
      },
    });
    const worker = createWorker({ reddit: redditAdapter, now: () => now });
    const denied = message({ stage: "comments", runId: run.id, itemId: "t3_denied" });
    const sibling = message({ stage: "comments", runId: run.id, itemId: "t3_sibling" });

    await worker.queue?.(
      { messages: [denied, sibling] } as MessageBatch<never>,
      environment(pipeline) as never,
      {} as ExecutionContext,
    );

    expect(redditAdapter.getPostWithComments).toHaveBeenCalledTimes(2);
    expect(denied.ack).toHaveBeenCalledOnce();
    expect(sibling.ack).toHaveBeenCalledOnce();
    expect(pipeline.send).toHaveBeenCalledWith({
      stage: "summarize",
      runId: run.id,
      itemId: "t3_sibling",
    });
    expect(await repository.getCandidate(run.id, "t3_denied")).toMatchObject({ status: "failed" });
    expect(await repository.getCandidate(run.id, "t3_sibling")).toMatchObject({ status: "comments_ready" });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
  ] as const)("fails and acknowledges Reddit %i access denial so it is not retried", async (status, errorCode) => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const worker = createWorker({ reddit: reddit({ listTopPosts: async () => { throw new RedditAccessDenied(status); } }), now: () => now });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: "failed", errorCode });
  });

  it("retries access denial when persisting the failed run throws", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    vi.spyOn(Repository.prototype, "markRunFailed").mockRejectedValueOnce(new Error("D1 unavailable"));
    const worker = createWorker({
      reddit: reddit({ listTopPosts: async () => { throw new RedditAccessDenied(403); } }),
      now: () => now,
    });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(await repository.getAnonymousCollection()).toEqual({
      enabled: true,
      consecutiveFailures: 1,
    });
  });

  it("retries an unknown recovery-write failure and continues to later messages", async () => {
    const pipeline = queue();
    const firstRun = (await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() })).run;
    const secondRun = (await repository.createOrGetRun({ localDate: "2026-07-25", startedAt: now.toISOString() })).run;
    const redditAdapter = reddit({
      listTopPosts: async () => {
        if (redditAdapter.listTopPosts.mock.calls.length === 1) {
          throw new RedditUnexpectedResponse("bad response");
        }
        return [item("t3_later")];
      },
    });
    vi.spyOn(Repository.prototype, "markRunPartial").mockRejectedValueOnce(new Error("D1 unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = createWorker({ reddit: redditAdapter, now: () => now });
    const first = message({ stage: "discover", runId: firstRun.id });
    const later = message({ stage: "discover", runId: secondRun.id });

    await worker.queue?.({ messages: [first, later] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(first.ack).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith({
      event: "pipeline_delivery_failed",
      runId: firstRun.id,
      stage: "discover",
      attempt: 1,
      decision: "retry",
      category: "unhandled_message_failure",
    });
    expect(later.ack).toHaveBeenCalledOnce();
    expect(pipeline.send).toHaveBeenCalledWith(
      {
        stage: "comments",
        runId: secondRun.id,
        itemId: "t3_later",
      },
      { delaySeconds: 75 },
    );
  });
});
