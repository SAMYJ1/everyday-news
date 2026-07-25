import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "../src/db/repository";
import type {
  Candidate,
  KnowledgeCardRecord,
  SourceComment,
  SourceItem,
} from "../src/domain";
import { createWorker } from "../src/index";
import {
  recordAccessFailure,
  syncSourceState,
} from "../src/pipeline/cleanup";
import type { PipelineDeps } from "../src/pipeline/discover";
import type { RedditSourceAdapter } from "../src/reddit/adapter";
import {
  RedditAccessDenied,
  RedditChallenge,
  RedditRateLimited,
} from "../src/reddit/anonymous-json";
import { applyMigrations } from "./apply-migrations";

const now = new Date("2026-07-25T00:00:00.000Z");

function sourceItem(
  id: string,
  overrides: Partial<SourceItem> = {},
): SourceItem {
  return {
    id,
    source: "reddit",
    externalId: id,
    title: `Title for ${id}`,
    author: "source-author",
    redditUrl: `https://reddit.com/r/todayilearned/comments/${id.slice(3)}`,
    sourceUrl: `https://example.test/${id}`,
    score: 100,
    upvoteRatio: 0.9,
    commentCount: 10,
    publishedAt: "2026-07-01T00:00:00.000Z",
    fetchedAt: "2026-07-01T00:00:00.000Z",
    lastCheckedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function candidate(itemId: string): Candidate {
  return {
    id: `run-1:${itemId}`,
    runId: "run-1",
    itemId,
    score: 100,
    reasons: ["popular"],
    rank: 1,
    status: "summarized",
    selectedAt: now.toISOString(),
  };
}

function comment(itemId: string): SourceComment {
  return {
    id: "t1_comment",
    itemId,
    externalId: "t1_comment",
    parentExternalId: itemId,
    author: "comment-author",
    body: "A retained comment body.",
    score: 10,
    depth: 0,
    redditUrl: "https://reddit.com/comment",
    publishedAt: now.toISOString(),
    fetchedAt: now.toISOString(),
    deletedAt: null,
    deleted: false,
  };
}

function summary(candidateId: string): KnowledgeCardRecord {
  return {
    id: "summary-1",
    candidateId,
    status: "draft",
    titleZh: "中文标题",
    oneLineFact: "一句事实。",
    whyInteresting: "很有意思。",
    commentInsights: ["评论补充"],
    caveats: ["仍需核查"],
    confidenceNote: "仅基于来源。",
    model: "@cf/test/model",
    promptVersion: "v1",
    inputHash: "sha256:test",
    generatedAt: now.toISOString(),
  };
}

function fakeReddit(
  check: (
    ids: string[],
  ) => Promise<Array<{ id: string; deleted: boolean }>>,
  list: () => Promise<SourceItem[]> = async () => [],
): RedditSourceAdapter {
  return {
    listTopPosts: list,
    getPostWithComments: async () => {
      throw new Error("getPostWithComments must not run during cleanup");
    },
    checkItems: check,
  };
}

function queueMessage(runId: string) {
  return {
    body: { stage: "discover" as const, runId },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function clearDatabase(): Promise<void> {
  await env.DB.batch(
    [
      "review_actions",
      "regeneration_requests",
      "summaries",
      "candidates",
      "source_comments",
      "source_items",
      "fetch_runs",
      "settings",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
}

describe("source cleanup", () => {
  let repository: Repository;

  beforeEach(async () => {
    await applyMigrations();
    await clearDatabase();
    repository = new Repository(env.DB);
  });

  it("checks recent retained items daily and older retained items after seven days", async () => {
    const items = [
      sourceItem("t3_recent_due", {
        fetchedAt: "2026-07-24T00:00:00.000Z",
        lastCheckedAt: "2026-07-24T00:00:00.000Z",
      }),
      sourceItem("t3_recent_fresh", {
        fetchedAt: "2026-07-24T00:00:00.000Z",
        lastCheckedAt: "2026-07-24T12:00:00.000Z",
      }),
      sourceItem("t3_old_due", {
        lastCheckedAt: "2026-07-18T00:00:00.000Z",
      }),
      sourceItem("t3_old_fresh", {
        lastCheckedAt: "2026-07-18T00:00:00.001Z",
      }),
      sourceItem("t3_already_deleted", {
        lastCheckedAt: "2026-07-01T00:00:00.000Z",
        deletedAt: "2026-07-02T00:00:00.000Z",
      }),
    ];
    for (const item of items) await repository.upsertSourceItem(item);
    const checkedIds: string[][] = [];
    const reddit = fakeReddit(async (ids) => {
      checkedIds.push(ids);
      return ids.map((id) => ({ id, deleted: false }));
    });

    await expect(
      syncSourceState({ repository, reddit } as PipelineDeps, now),
    ).resolves.toEqual({ checked: 2, removed: 0 });

    expect(checkedIds).toEqual([["t3_old_due", "t3_recent_due"]]);
    expect(await repository.getSourceItem("t3_recent_due")).toMatchObject({
      lastCheckedAt: now.toISOString(),
    });
    expect(await repository.getSourceItem("t3_old_due")).toMatchObject({
      lastCheckedAt: now.toISOString(),
    });
    expect(await repository.getSourceItem("t3_recent_fresh")).toMatchObject({
      lastCheckedAt: "2026-07-24T12:00:00.000Z",
    });
  });

  it("clears deleted source fields and hides every dependent card in one cleanup", async () => {
    const item = sourceItem("t3_deleted", {
      fetchedAt: "2026-07-24T00:00:00.000Z",
      lastCheckedAt: "2026-07-24T00:00:00.000Z",
    });
    await repository.createRun({
      id: "run-1",
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    await repository.upsertSourceItem(item);
    await repository.replaceComments(item.id, [comment(item.id)]);
    await repository.saveCandidate(candidate(item.id));
    await repository.saveSummary(summary(`run-1:${item.id}`));
    const reddit = fakeReddit(async (ids) =>
      ids.map((id) => ({ id, deleted: true })),
    );

    await expect(
      syncSourceState({ repository, reddit } as PipelineDeps, now),
    ).resolves.toEqual({ checked: 1, removed: 1 });

    expect(await repository.getSourceItem(item.id)).toMatchObject({
      title: null,
      author: null,
      sourceUrl: null,
      lastCheckedAt: now.toISOString(),
      deletedAt: now.toISOString(),
    });
    expect(await repository.listComments(item.id)).toEqual([
      expect.objectContaining({
        author: null,
        body: "",
        deleted: true,
        deletedAt: now.toISOString(),
      }),
    ]);
    expect(
      await env.DB
        .prepare("SELECT status FROM summaries WHERE id = ?")
        .bind("summary-1")
        .first(),
    ).toEqual({ status: "source_deleted" });
    expect(await repository.listCards()).toEqual([]);
    expect(await repository.listCards("source_deleted")).toEqual([]);
    expect(await repository.getCard("summary-1")).toBeNull();
  });

  it("runs cleanup before discovery using only the injected source adapter", async () => {
    await repository.upsertSourceItem(
      sourceItem("t3_retained", {
        fetchedAt: "2026-07-24T00:00:00.000Z",
        lastCheckedAt: "2026-07-24T00:00:00.000Z",
      }),
    );
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    const calls: string[] = [];
    const reddit = fakeReddit(
      async (ids) => {
        calls.push("cleanup");
        return ids.map((id) => ({ id, deleted: false }));
      },
      async () => {
        calls.push("discover");
        return [];
      },
    );
    const worker = createWorker({ reddit, now: () => now });
    const message = queueMessage(run.id);

    await worker.queue?.(
      { messages: [message] } as MessageBatch<never>,
      { ...env, PIPELINE: { send: vi.fn() } } as never,
      {} as ExecutionContext,
    );

    expect(calls).toEqual(["cleanup", "discover"]);
    expect(message.ack).toHaveBeenCalledOnce();
  });
});

describe("anonymous access circuit breaker", () => {
  let repository: Repository;

  beforeEach(async () => {
    await applyMigrations();
    await clearDatabase();
    repository = new Repository(env.DB);
  });

  it("disables anonymous collection on the third exact access failure", async () => {
    expect(
      await recordAccessFailure(repository, "unauthorized", "2026-07-23T00:00:00.000Z"),
    ).toEqual({ consecutiveFailures: 1, anonymousEnabled: true });
    expect(
      await recordAccessFailure(repository, "forbidden", "2026-07-24T00:00:00.000Z"),
    ).toEqual({ consecutiveFailures: 2, anonymousEnabled: true });
    expect(
      await recordAccessFailure(repository, "rate_limited", now.toISOString()),
    ).toEqual({ consecutiveFailures: 3, anonymousEnabled: false });
  });

  it("does not count failures outside the four access-control codes", async () => {
    await expect(
      recordAccessFailure(
        repository,
        "temporary_failure" as never,
        now.toISOString(),
      ),
    ).rejects.toThrow("Unsupported Reddit access failure code");
    expect(await repository.getAnonymousCollection()).toEqual({
      enabled: true,
      consecutiveFailures: 0,
    });
  });

  it("resets the consecutive failure count after successful discovery", async () => {
    await recordAccessFailure(repository, "challenge", "2026-07-23T00:00:00.000Z");
    await recordAccessFailure(repository, "forbidden", "2026-07-24T00:00:00.000Z");
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    const reddit = fakeReddit(async () => [], async () => []);
    const worker = createWorker({ reddit, now: () => now });
    const message = queueMessage(run.id);

    await worker.queue?.(
      { messages: [message] } as MessageBatch<never>,
      { ...env, PIPELINE: { send: vi.fn() } } as never,
      {} as ExecutionContext,
    );

    expect(await repository.getAnonymousCollection()).toEqual({
      enabled: true,
      consecutiveFailures: 0,
    });
  });

  it("manual re-enable resets failures and records the supplied audit time", async () => {
    await recordAccessFailure(repository, "unauthorized", "2026-07-22T00:00:00.000Z");
    await recordAccessFailure(repository, "forbidden", "2026-07-23T00:00:00.000Z");
    await recordAccessFailure(repository, "challenge", "2026-07-24T00:00:00.000Z");

    await repository.setAnonymousEnabled(true, now.toISOString());

    expect(await repository.getAnonymousCollection()).toEqual({
      enabled: true,
      consecutiveFailures: 0,
    });
    expect(
      await env.DB
        .prepare("SELECT updated_at FROM settings WHERE key = ?")
        .bind("anonymous_collection")
        .first(),
    ).toEqual({ updated_at: now.toISOString() });
  });

  it("records anonymous_disabled and makes no Reddit call while collection is disabled", async () => {
    await repository.setAnonymousEnabled(false, "2026-07-24T00:00:00.000Z");
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    const reddit = {
      listTopPosts: vi.fn(async () => []),
      getPostWithComments: vi.fn(),
      checkItems: vi.fn(async () => []),
    };
    const worker = createWorker({ reddit, now: () => now });
    const message = queueMessage(run.id);

    await worker.queue?.(
      { messages: [message] } as MessageBatch<never>,
      { ...env, PIPELINE: { send: vi.fn() } } as never,
      {} as ExecutionContext,
    );

    expect(reddit.listTopPosts).not.toHaveBeenCalled();
    expect(reddit.checkItems).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await repository.getRunByLocalDate("2026-07-25")).toMatchObject({
      status: "failed",
      errorCode: "anonymous_disabled",
    });
  });

  it.each([
    ["unauthorized", new RedditAccessDenied(401)],
    ["forbidden", new RedditAccessDenied(403)],
    ["rate_limited", new RedditRateLimited(0)],
    ["challenge", new RedditChallenge()],
  ] as const)("records %s as an exact terminal access code", async (code, failure) => {
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    const reddit = fakeReddit(async () => [], async () => {
      throw failure;
    });
    const worker = createWorker({ reddit, now: () => now });
    const message = queueMessage(run.id);

    await worker.queue?.(
      { messages: [message] } as MessageBatch<never>,
      { ...env, PIPELINE: { send: vi.fn() } } as never,
      {} as ExecutionContext,
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await repository.getRunByLocalDate("2026-07-25")).toMatchObject({
      status: "failed",
      errorCode: code,
    });
    expect(await repository.getAnonymousCollection()).toEqual({
      enabled: true,
      consecutiveFailures: 1,
    });
  });
});
