import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkersAiTemporaryFailure } from "../src/ai/workers-ai";
import { Repository } from "../src/db/repository";
import type { Candidate, SourceComment, SourceItem } from "../src/domain";
import { createWorker } from "../src/index";
import {
  RedditAccessDenied,
  RedditTemporaryFailure,
  RedditUnexpectedResponse,
} from "../src/reddit/anonymous-json";
import { applyMigrations } from "./apply-migrations";

const now = new Date("2026-07-24T00:30:00.000Z");

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

function queue() {
  const send = vi.fn(async () => undefined);
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
    ["review_actions", "summaries", "candidates", "source_comments", "source_items", "fetch_runs", "settings"]
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
    expect(run).toMatchObject({ localDate: "2026-07-24", status: "queued" });
    expect(pipeline.send).toHaveBeenCalledTimes(1);
    expect(pipeline.send).toHaveBeenCalledWith({ stage: "discover", runId: run?.id });
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

  it("fails and acknowledges access denial so Reddit is not retried", async () => {
    const pipeline = queue();
    const { run } = await repository.createOrGetRun({ localDate: "2026-07-24", startedAt: now.toISOString() });
    const worker = createWorker({ reddit: reddit({ listTopPosts: async () => { throw new RedditAccessDenied(403); } }), now: () => now });
    const queued = message({ stage: "discover", runId: run.id });

    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({ status: "failed", errorCode: "reddit_access_denied" });
  });
});
