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
  checkComments: (
    ids: string[],
  ) => Promise<Array<{ id: string; deleted: boolean }>> = async (ids) =>
    ids.map((id) => ({ id, deleted: false })),
): RedditSourceAdapter {
  return {
    listTopPosts: list,
    getPostWithComments: async () => {
      throw new Error("getPostWithComments must not run during cleanup");
    },
    checkItems: check,
    checkComments,
  };
}

function queueMessage(runId: string) {
  return {
    body: { stage: "discover" as const, runId },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function commentsMessage(runId: string, itemId: string) {
  return {
    body: { stage: "comments" as const, runId, itemId },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function summarizeMessage(
  runId: string,
  itemId: string,
  regeneration?: { id: string; nonce: string },
) {
  return {
    body: { stage: "summarize" as const, runId, itemId, regeneration },
    attempts: 1,
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

  it("fences stale source, comment, and summary writers after cleanup wins", async () => {
    const item = sourceItem("t3_race", {
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
    expect(
      await repository.claimCandidateForSummary(
        `run-1:${item.id}`,
        "stale-summary-owner",
        now.toISOString(),
        "2026-07-24T00:00:00.000Z",
      ),
    ).toBe(true);
    const reddit = fakeReddit(async (ids) =>
      ids.map((id) => ({ id, deleted: true })),
    );
    await syncSourceState({ repository, reddit } as PipelineDeps, now);

    await repository.upsertSourceItem({
      ...item,
      title: "Stale restored title",
      author: "stale-author",
      sourceUrl: "https://example.test/stale",
      lastCheckedAt: "2026-07-25T00:01:00.000Z",
      deletedAt: null,
    });
    await repository.replaceComments(item.id, [
      {
        ...comment(item.id),
        author: "stale-commenter",
        body: "A stale comment body that must not return.",
        fetchedAt: "2026-07-25T00:01:00.000Z",
      },
    ]);
    await repository.saveSummary({
      ...summary(`run-1:${item.id}`),
      titleZh: "不应恢复",
      status: "draft",
    });
    expect(
      await repository.saveSummaryForClaim(
        {
          ...summary(`run-1:${item.id}`),
          titleZh: "过期生成",
          status: "draft",
        },
        "stale-summary-owner",
      ),
    ).toBe(false);
    await repository.saveSummary({
      ...summary(`run-1:${item.id}`),
      id: "late-summary",
      inputHash: "sha256:late",
    });

    expect(await repository.getSourceItem(item.id)).toMatchObject({
      title: null,
      author: null,
      sourceUrl: null,
      deletedAt: now.toISOString(),
    });
    expect(await repository.listComments(item.id)).toEqual([
      expect.objectContaining({
        author: null,
        body: "",
        deleted: true,
      }),
    ]);
    expect(
      await env.DB
        .prepare("SELECT status, title_zh FROM summaries WHERE id = ?")
        .bind("summary-1")
        .first(),
    ).toEqual({ status: "source_deleted", title_zh: "中文标题" });
    expect(
      await env.DB
        .prepare("SELECT id FROM summaries WHERE id = ?")
        .bind("late-summary")
        .first(),
    ).toBeNull();
    expect(await repository.listCards()).toEqual([]);
  });

  it("scrubs a deleted stored comment while its parent post remains live", async () => {
    const item = sourceItem("t3_live_parent", {
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
    const checkedComments: string[][] = [];
    const reddit = fakeReddit(
      async (ids) => ids.map((id) => ({ id, deleted: false })),
      async () => [],
      async (ids) => {
        checkedComments.push(ids);
        return ids.map((id) => ({ id, deleted: true }));
      },
    );

    await expect(
      syncSourceState({ repository, reddit } as PipelineDeps, now),
    ).resolves.toEqual({ checked: 1, removed: 0 });

    expect(checkedComments).toEqual([["t1_comment"]]);
    expect(await repository.getSourceItem(item.id)).toMatchObject({
      deletedAt: null,
      lastCheckedAt: now.toISOString(),
    });
    expect(await repository.listComments(item.id)).toEqual([
      expect.objectContaining({
        author: null,
        body: "",
        deletedAt: now.toISOString(),
        deleted: true,
      }),
    ]);
    expect(
      await env.DB
        .prepare("SELECT status FROM summaries WHERE id = ?")
        .bind("summary-1")
        .first(),
    ).toEqual({ status: "source_deleted" });
    expect(await repository.listCards()).toEqual([]);
    expect(await repository.getCard("summary-1")).toBeNull();
  });

  it("preserves a deleted comment tombstone against a stale comment replacement", async () => {
    const item = sourceItem("t3_live_stale_comment", {
      fetchedAt: "2026-07-24T00:00:00.000Z",
      lastCheckedAt: "2026-07-24T00:00:00.000Z",
    });
    await repository.upsertSourceItem(item);
    await repository.replaceComments(item.id, [comment(item.id)]);
    const reddit = fakeReddit(
      async (ids) => ids.map((id) => ({ id, deleted: false })),
      async () => [],
      async (ids) => ids.map((id) => ({ id, deleted: true })),
    );
    await syncSourceState({ repository, reddit } as PipelineDeps, now);

    await repository.replaceComments(item.id, [
      {
        ...comment(item.id),
        author: "stale-author",
        body: "This stale body was fetched before the deletion check completed.",
        fetchedAt: "2026-07-25T00:01:00.000Z",
        deletedAt: null,
        deleted: false,
      },
    ]);

    expect(await repository.listComments(item.id)).toEqual([
      expect.objectContaining({
        id: "t1_comment",
        author: null,
        body: "",
        deletedAt: now.toISOString(),
        deleted: true,
      }),
    ]);
  });

  it("fences stale and new summaries after an individual comment tombstone", async () => {
    const item = sourceItem("t3_live_stale_summary", {
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
    expect(
      await repository.claimCandidateForSummary(
        `run-1:${item.id}`,
        "stale-comment-summary-owner",
        now.toISOString(),
        "2026-07-24T00:00:00.000Z",
      ),
    ).toBe(true);
    const reddit = fakeReddit(
      async (ids) => ids.map((id) => ({ id, deleted: false })),
      async () => [],
      async (ids) => ids.map((id) => ({ id, deleted: true })),
    );
    await syncSourceState({ repository, reddit } as PipelineDeps, now);

    expect(
      await repository.saveSummaryForClaim(
        {
          ...summary(`run-1:${item.id}`),
          titleZh: "过期摘要",
        },
        "stale-comment-summary-owner",
      ),
    ).toBe(false);
    await repository.saveSummary({
      ...summary(`run-1:${item.id}`),
      titleZh: "直接恢复",
    });
    await repository.saveSummary({
      ...summary(`run-1:${item.id}`),
      id: "new-comment-summary",
      inputHash: "sha256:new-comment-summary",
      titleZh: "新摘要",
    });

    expect(
      await env.DB
        .prepare("SELECT status, title_zh FROM summaries WHERE id = ?")
        .bind("summary-1")
        .first(),
    ).toEqual({ status: "source_deleted", title_zh: "中文标题" });
    expect(
      await env.DB
        .prepare("SELECT id FROM summaries WHERE id = ?")
        .bind("new-comment-summary")
        .first(),
    ).toBeNull();
    expect(await repository.listCards()).toEqual([]);
    expect(await repository.getCard("summary-1")).toBeNull();
  });

  it("terminalizes an original summary claim when its source is deleted after generation", async () => {
    const item = sourceItem("t3_deleted_during_generation");
    await repository.createRun({
      id: "run-1",
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    await repository.upsertSourceItem(item);
    await repository.replaceComments(item.id, [comment(item.id)]);
    await repository.saveCandidate({
      ...candidate(item.id),
      status: "comments_ready",
    });
    await repository.completeDiscovery(
      "run-1",
      { discovered: 1, selected: 1 },
      now.toISOString(),
    );
    const generator = {
      generate: vi.fn(async () => {
        await repository.removeDeletedSourceItem(item.id, now.toISOString());
        return {
          titleZh: "不应保存",
          oneLineFact: "来源已删除。",
          whyInteresting: "不应展示。",
          commentInsights: [],
          caveats: ["来源已删除。"],
          confidenceNote: "不可用。",
        };
      }),
    };
    const worker = createWorker({
      reddit: fakeReddit(async () => []),
      generator,
      now: () => now,
    });
    const message = summarizeMessage("run-1", item.id);

    await worker.queue?.(
      { messages: [message] } as MessageBatch<never>,
      { ...env, PIPELINE: { send: vi.fn() } } as never,
      {} as ExecutionContext,
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await repository.getCandidate("run-1", item.id)).toMatchObject({
      status: "failed",
    });
    expect(await repository.getRunByLocalDate("2026-07-25")).toMatchObject({
      status: "failed",
    });
    expect(await repository.listCards()).toEqual([]);
  });

  it("terminalizes a regeneration when a source comment is deleted after generation", async () => {
    const item = sourceItem("t3_comment_deleted_during_regeneration");
    await repository.createRun({
      id: "run-1",
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    await repository.upsertSourceItem(item);
    await repository.replaceComments(item.id, [comment(item.id)]);
    await repository.saveCandidate(candidate(item.id));
    await repository.completeDiscovery(
      "run-1",
      { discovered: 1, selected: 1 },
      now.toISOString(),
    );
    await repository.saveSummary(summary(`run-1:${item.id}`));
    const regeneration = await repository.createOrGetCardRegeneration(
      "summary-1",
      now.toISOString(),
    );
    expect(regeneration).not.toBeNull();
    const generator = {
      generate: vi.fn(async () => {
        await repository.removeDeletedSourceComment(
          "t1_comment",
          now.toISOString(),
        );
        return {
          titleZh: "不应替换",
          oneLineFact: "评论已删除。",
          whyInteresting: "不应展示。",
          commentInsights: [],
          caveats: ["评论已删除。"],
          confidenceNote: "不可用。",
        };
      }),
    };
    const worker = createWorker({
      reddit: fakeReddit(async () => []),
      generator,
      now: () => now,
    });
    const message = summarizeMessage("run-1", item.id, {
      id: regeneration!.id,
      nonce: regeneration!.nonce,
    });

    await worker.queue?.(
      { messages: [message] } as MessageBatch<never>,
      { ...env, PIPELINE: { send: vi.fn() } } as never,
      {} as ExecutionContext,
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await repository.getCandidate("run-1", item.id)).toMatchObject({
      status: "failed",
    });
    expect(await repository.getActiveCardRegeneration(`run-1:${item.id}`)).toBeNull();
    expect(await repository.getRunByLocalDate("2026-07-25")).toMatchObject({
      status: "failed",
    });
    expect(await repository.listCards()).toEqual([]);
  });

  it("rejects a stale review after cleanup and defensively hides a corrupted card status", async () => {
    const item = sourceItem("t3_stale_review", {
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
    expect(await repository.getCard("summary-1")).toMatchObject({
      id: "summary-1",
      status: "draft",
    });
    const reddit = fakeReddit(
      async (ids) => ids.map((id) => ({ id, deleted: false })),
      async () => [],
      async (ids) => ids.map((id) => ({ id, deleted: true })),
    );
    await syncSourceState({ repository, reddit } as PipelineDeps, now);

    expect(
      await repository.recordReview(
        "summary-1",
        "approve",
        "2026-07-25T00:01:00.000Z",
      ),
    ).toBe(false);
    expect(
      await env.DB
        .prepare("SELECT status FROM summaries WHERE id = ?")
        .bind("summary-1")
        .first(),
    ).toEqual({ status: "source_deleted" });
    expect(await repository.listCards("approved")).toEqual([]);
    expect(await repository.getCard("summary-1")).toBeNull();

    await env.DB
      .prepare(
        "UPDATE summaries SET status = 'approved', reviewed_at = ? WHERE id = ?",
      )
      .bind("2026-07-25T00:02:00.000Z", "summary-1")
      .run();
    expect(await repository.listCards()).toEqual([]);
    expect(await repository.listCards("approved")).toEqual([]);
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

  it("counts failures once per consecutive Shanghai calendar day and resets after a gap", async () => {
    expect(
      await recordAccessFailure(repository, "forbidden", "2026-07-23T00:00:00.000Z"),
    ).toEqual({ consecutiveFailures: 1, anonymousEnabled: true });
    expect(
      await recordAccessFailure(repository, "forbidden", "2026-07-23T15:59:59.000Z"),
    ).toEqual({ consecutiveFailures: 1, anonymousEnabled: true });
    expect(
      await recordAccessFailure(repository, "forbidden", "2026-07-23T16:00:00.000Z"),
    ).toEqual({ consecutiveFailures: 2, anonymousEnabled: true });
    expect(
      await recordAccessFailure(repository, "forbidden", "2026-07-25T16:00:00.000Z"),
    ).toEqual({ consecutiveFailures: 1, anonymousEnabled: true });
    expect(
      await recordAccessFailure(repository, "forbidden", "2026-07-26T16:00:00.000Z"),
    ).toEqual({ consecutiveFailures: 2, anonymousEnabled: true });
    expect(
      await recordAccessFailure(repository, "forbidden", "2026-07-27T16:00:00.000Z"),
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

  it("does not reset failures when a discovery checkpoint avoids every Reddit request", async () => {
    await recordAccessFailure(repository, "challenge", "2026-07-23T00:00:00.000Z");
    await recordAccessFailure(repository, "forbidden", "2026-07-24T00:00:00.000Z");
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    await repository.completeDiscovery(
      run.id,
      { discovered: 0, selected: 0 },
      "2026-07-24T00:00:00.000Z",
    );
    const reddit = {
      listTopPosts: vi.fn(async () => []),
      getPostWithComments: vi.fn(),
      checkItems: vi.fn(async () => []),
      checkComments: vi.fn(async () => []),
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
    expect(await repository.getAnonymousCollection()).toEqual({
      enabled: true,
      consecutiveFailures: 2,
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
        .prepare(
          "SELECT updated_at, last_failure_local_date FROM settings WHERE key = ?",
        )
        .bind("anonymous_collection")
        .first(),
    ).toEqual({
      updated_at: now.toISOString(),
      last_failure_local_date: null,
    });
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
      checkComments: vi.fn(async () => []),
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

  it("acks pending comment work without Reddit and fails its candidate when collection is disabled", async () => {
    await repository.setAnonymousEnabled(false, "2026-07-24T00:00:00.000Z");
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    const item = sourceItem("t3_pending_comments");
    await repository.upsertSourceItem(item);
    await repository.saveCandidate({
      ...candidate(item.id),
      id: `${run.id}:${item.id}`,
      runId: run.id,
      status: "selected",
    });
    const reddit = {
      listTopPosts: vi.fn(async () => []),
      getPostWithComments: vi.fn(async () => ({
        item,
        comments: [comment(item.id)],
      })),
      checkItems: vi.fn(async () => []),
      checkComments: vi.fn(async () => []),
    };
    const worker = createWorker({ reddit, now: () => now });
    const message = commentsMessage(run.id, item.id);

    await worker.queue?.(
      { messages: [message] } as MessageBatch<never>,
      { ...env, PIPELINE: { send: vi.fn() } } as never,
      {} as ExecutionContext,
    );

    expect(reddit.getPostWithComments).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await repository.getCandidate(run.id, item.id)).toMatchObject({
      status: "failed",
    });
    expect(await repository.getRunByLocalDate("2026-07-25")).toMatchObject({
      status: "failed",
      errorCode: "anonymous_disabled",
    });
  });

  it("allows already-collected summaries to finish while Reddit collection is disabled", async () => {
    await repository.setAnonymousEnabled(false, "2026-07-24T00:00:00.000Z");
    await repository.createRun({
      id: "run-1",
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    const item = sourceItem("t3_ready_to_summarize");
    await repository.upsertSourceItem(item);
    await repository.replaceComments(item.id, [comment(item.id)]);
    await repository.saveCandidate({
      ...candidate(item.id),
      status: "comments_ready",
    });
    await repository.completeDiscovery(
      "run-1",
      { discovered: 1, selected: 1 },
      now.toISOString(),
    );
    const reddit = {
      listTopPosts: vi.fn(async () => []),
      getPostWithComments: vi.fn(),
      checkItems: vi.fn(async () => []),
      checkComments: vi.fn(async () => []),
    };
    const generate = vi.fn(async () => ({
      decision: "publish" as const,
      decisionReason: "内容具体且评论提供了信息增量。",
      titleZh: "可继续完成",
      oneLineFact: "已有输入不需要再次访问 Reddit。",
      whyInteresting: "避免丢弃已经安全收集的工作。",
      commentInsights: [{ text: "评论已存储。", commentIndex: 0 }],
      caveats: ["来源采集当前暂停。"],
      confidenceNote: "仅使用已保存输入。",
    }));
    const worker = createWorker({
      reddit,
      generator: { generate },
      now: () => now,
    });
    const message = summarizeMessage("run-1", item.id);

    await worker.queue?.(
      { messages: [message] } as MessageBatch<never>,
      { ...env, PIPELINE: { send: vi.fn() } } as never,
      {} as ExecutionContext,
    );

    expect(generate).toHaveBeenCalledOnce();
    expect(reddit.listTopPosts).not.toHaveBeenCalled();
    expect(reddit.getPostWithComments).not.toHaveBeenCalled();
    expect(reddit.checkItems).not.toHaveBeenCalled();
    expect(reddit.checkComments).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(await repository.listCards("approved")).toHaveLength(1);
  });

  it("persists the terminal run failure even when breaker persistence fails", async () => {
    const { run } = await repository.createOrGetRun({
      localDate: "2026-07-25",
      startedAt: now.toISOString(),
    });
    vi.spyOn(Repository.prototype, "recordAnonymousFailure")
      .mockRejectedValueOnce(new Error("settings unavailable"));
    const reddit = fakeReddit(async () => [], async () => {
      throw new RedditAccessDenied(403);
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
      errorCode: "forbidden",
    });
  });

  it.each([
    ["unauthorized", new RedditAccessDenied(401)],
    ["forbidden", new RedditAccessDenied(403)],
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
