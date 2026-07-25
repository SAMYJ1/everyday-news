import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkersAiTemporaryFailure } from "../src/ai/workers-ai";
import { Repository } from "../src/db/repository";
import type { Candidate, SourceComment, SourceItem } from "../src/domain";
import { createWorker } from "../src/index";
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
    titleZh: "中文标题",
    oneLineFact: "原帖声称一件值得了解的事。",
    whyInteresting: "这件事提供了一个有趣的视角。",
    commentInsights: ["评论补充了背景。"],
    caveats: ["尚未进行外部事实核查。"],
    confidenceNote: "内容仅基于原帖和评论。",
  };
}

function queue(sendImplementation: (message: unknown) => Promise<void> = async () => undefined) {
  const send = vi.fn(sendImplementation);
  return { send };
}

function message(body: { stage: "discover"; runId: string } | { stage: "comments" | "summarize"; runId: string; itemId: string }) {
  return {
    body,
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
  };
}

function environment(pipeline: ReturnType<typeof queue>) {
  return { ...env, PIPELINE: pipeline };
}

describe("pipeline orchestration", () => {
  let repository: Repository;

  beforeEach(async () => {
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
    expect(pipeline.send).toHaveBeenCalledWith({ stage: "comments", runId: run.id, itemId: "t3_one" });
    expect(pipeline.send).toHaveBeenCalledWith({ stage: "comments", runId: run.id, itemId: "t3_two" });
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
    ["failed", "partial"],
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
    new RedditRateLimited(30),
    new RedditTemporaryFailure("Reddit unavailable"),
    new WorkersAiTemporaryFailure("AI unavailable"),
  ])("retries typed temporary failures", async (failure) => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const worker = createWorker({ reddit: reddit({ listTopPosts: async () => { throw failure; } }), now: () => now });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.retry).toHaveBeenCalledOnce();
    expect(queued.ack).not.toHaveBeenCalled();
  });

  it.each([401, 403])("fails and acknowledges Reddit %i access denial so it is not retried", async (status) => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const worker = createWorker({ reddit: reddit({ listTopPosts: async () => { throw new RedditAccessDenied(status); } }), now: () => now });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: "failed", errorCode: "reddit_access_denied" });
  });

  it("acknowledges access denial even when persisting the failed run throws", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    vi.spyOn(Repository.prototype, "markRunFailed").mockRejectedValueOnce(new Error("D1 unavailable"));
    const worker = createWorker({
      reddit: reddit({ listTopPosts: async () => { throw new RedditAccessDenied(403); } }),
      now: () => now,
    });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("acknowledges an unknown recovery-write failure and continues to later messages", async () => {
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
    const worker = createWorker({ reddit: redditAdapter, now: () => now });
    const first = message({ stage: "discover", runId: firstRun.id });
    const later = message({ stage: "discover", runId: secondRun.id });

    await worker.queue?.({ messages: [first, later] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(later.ack).toHaveBeenCalledOnce();
    expect(pipeline.send).toHaveBeenCalledWith({
      stage: "comments",
      runId: secondRun.id,
      itemId: "t3_later",
    });
  });
});
