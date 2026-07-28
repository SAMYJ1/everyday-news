import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Candidate, SourceItem } from "../src/domain";
import { Repository } from "../src/db/repository";
import { discoverCandidates, type PipelineDeps } from "../src/pipeline/discover";
import { applyMigrations } from "./apply-migrations";

const now = new Date("2026-07-24T00:00:00.000Z");

function sourceItem(index: number, overrides: Partial<SourceItem> = {}): SourceItem {
  const id = `t3_post${index}`;
  return {
    id,
    source: "reddit",
    externalId: id,
    title: `Useful source item ${index}`,
    author: "author",
    redditUrl: `https://reddit.com/r/todayilearned/comments/post${index}`,
    sourceUrl: `https://example.test/source/${index}`,
    score: 100 + index,
    upvoteRatio: 0.9,
    commentCount: 100 + index,
    publishedAt: "2026-07-23T20:00:00.000Z",
    fetchedAt: now.toISOString(),
    lastCheckedAt: now.toISOString(),
    deletedAt: null,
    ...overrides
  };
}

function deps(posts: SourceItem[], recentUrls = new Set<string>()): {
  deps: PipelineDeps;
  listTopPosts: ReturnType<typeof vi.fn>;
  upsertSourceItem: ReturnType<typeof vi.fn>;
  saveCandidate: ReturnType<typeof vi.fn>;
} {
  const listTopPosts = vi.fn(async () => posts);
  const upsertSourceItem = vi.fn(async () => undefined);
  const saveCandidate = vi.fn(async () => undefined);

  return {
    deps: {
      reddit: {
        listTopPosts,
        getPostWithComments: vi.fn(),
        checkItems: vi.fn(),
        checkComments: vi.fn(),
      },
      repository: {
        getRecentSourceUrls: vi.fn(async () => recentUrls),
        getRecentTitles: vi.fn(async () => []),
        upsertSourceItem,
        saveCandidate,
        listCandidatesForRun: vi.fn(async () => []),
        getDiscoveryCheckpoint: vi.fn(async () => null),
        completeDiscovery: vi.fn(async () => undefined)
      },
      now: () => now
    } as unknown as PipelineDeps,
    listTopPosts,
    upsertSourceItem,
    saveCandidate
  };
}

describe("discoverCandidates", () => {
  it("upserts every fetched item and persists the top five eligible candidates in rank order", async () => {
    const posts = Array.from({ length: 20 }, (_, index) => sourceItem(index + 1));
    posts[2] = sourceItem(3, { stickied: true });
    posts[5] = sourceItem(6, { deleted: true });
    posts[7] = sourceItem(8, { sourceUrl: null });
    posts[9] = sourceItem(10, { title: null });
    posts[11] = sourceItem(12, { over18: true });
    const { deps: pipelineDeps, listTopPosts, upsertSourceItem, saveCandidate } = deps(
      posts,
      new Set(["https://example.test/source/13"])
    );

    const result = await discoverCandidates(pipelineDeps, "run-1");

    expect(listTopPosts).toHaveBeenCalledWith({ limit: 20, time: "day" });
    expect(upsertSourceItem).toHaveBeenCalledTimes(20);
    expect(upsertSourceItem.mock.calls.map(([item]) => item.id)).toEqual(posts.map((item) => item.id));
    expect(result).toMatchObject({ discovered: 20, selected: 5 });
    expect(result.itemIds).toEqual(["t3_post20", "t3_post19", "t3_post18", "t3_post17", "t3_post16"]);
    expect(saveCandidate).toHaveBeenCalledTimes(5);
    expect(saveCandidate.mock.calls.map(([candidate]) => ({
      runId: (candidate as Candidate).runId,
      itemId: (candidate as Candidate).itemId,
      rank: (candidate as Candidate).rank,
      status: (candidate as Candidate).status,
      selectedAt: (candidate as Candidate).selectedAt
    }))).toEqual([
      { runId: "run-1", itemId: "t3_post20", rank: 1, status: "selected", selectedAt: now.toISOString() },
      { runId: "run-1", itemId: "t3_post19", rank: 2, status: "selected", selectedAt: now.toISOString() },
      { runId: "run-1", itemId: "t3_post18", rank: 3, status: "selected", selectedAt: now.toISOString() },
      { runId: "run-1", itemId: "t3_post17", rank: 4, status: "selected", selectedAt: now.toISOString() },
      { runId: "run-1", itemId: "t3_post16", rank: 5, status: "selected", selectedAt: now.toISOString() }
    ]);
  });

  it("selects and ranks every eligible item when fewer than five remain", async () => {
    const posts = [
      sourceItem(1, { score: 1_000, commentCount: 1_000 }),
      sourceItem(2, { stickied: true }),
      sourceItem(3, { score: 500, commentCount: 500 }),
      sourceItem(4, { sourceUrl: null }),
      sourceItem(5, { score: 100, commentCount: 100 })
    ];
    const { deps: pipelineDeps, saveCandidate } = deps(posts);

    const result = await discoverCandidates(pipelineDeps, "run-2");

    expect(result).toEqual({
      discovered: 5,
      selected: 3,
      itemIds: ["t3_post1", "t3_post3", "t3_post5"]
    });
    expect(saveCandidate.mock.calls.map(([candidate]) => (candidate as Candidate).rank)).toEqual([1, 2, 3]);
  });

  it("breaks equal-score ties by item id so ranks remain deterministic", async () => {
    const posts = [
      sourceItem(2, { score: 100, commentCount: 100 }),
      sourceItem(1, { score: 100, commentCount: 100 })
    ];
    const { deps: pipelineDeps } = deps(posts);

    const result = await discoverCandidates(pipelineDeps, "run-3");

    expect(result.itemIds).toEqual(["t3_post1", "t3_post2"]);
  });

  it("deduplicates the current listing by external ID and normalized source URL", async () => {
    const posts = [
      sourceItem(1),
      sourceItem(99, {
        id: "duplicate-id",
        externalId: "t3_post1",
        sourceUrl: "https://example.test/source/1",
      }),
      sourceItem(2, { sourceUrl: "HTTPS://EXAMPLE.TEST/source/1/#fragment", score: 500 }),
      sourceItem(3),
    ];
    const { deps: pipelineDeps, upsertSourceItem, saveCandidate } = deps(posts);

    const result = await discoverCandidates(pipelineDeps, "run-4");

    expect(result).toEqual({
      discovered: 3,
      selected: 2,
      itemIds: ["t3_post2", "t3_post3"],
    });
    expect(upsertSourceItem).toHaveBeenCalledTimes(3);
    expect(saveCandidate).toHaveBeenCalledTimes(2);
  });

  it("reuses a saved prefix when a discovery message is retried", async () => {
    const posts = Array.from({ length: 6 }, (_, index) => sourceItem(index + 1));
    const { deps: pipelineDeps, saveCandidate } = deps(posts);
    const saved: Candidate[] = [];
    saveCandidate.mockImplementation(async (value: Candidate) => {
      saved.push(value);
    });
    pipelineDeps.repository.listCandidatesForRun = vi.fn(async () => [...saved]);

    const first = await discoverCandidates(pipelineDeps, "run-retry");
    const second = await discoverCandidates(pipelineDeps, "run-retry");

    expect(first.itemIds).toEqual(second.itemIds);
    expect(saved).toHaveLength(5);
    expect(saved.map((candidate) => candidate.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("continues after a partially persisted candidate prefix", async () => {
    const posts = Array.from({ length: 6 }, (_, index) => sourceItem(index + 1));
    const { deps: pipelineDeps, saveCandidate } = deps(posts);
    const prefix = candidateFor("run-partial", "t3_post6", 1);
    pipelineDeps.repository.listCandidatesForRun = vi.fn(async () => [prefix]);

    const result = await discoverCandidates(pipelineDeps, "run-partial");

    expect(result).toEqual({
      discovered: 6,
      selected: 5,
      itemIds: ["t3_post6", "t3_post5", "t3_post4", "t3_post3", "t3_post2"],
    });
    expect(
      saveCandidate.mock.calls.map(([value]) => (value as Candidate).rank),
    ).toEqual([2, 3, 4, 5]);
  });

  it("is idempotent against D1 when the same discovery run is delivered twice", async () => {
    await applyMigrations();
    await env.DB.batch(
      ["summaries", "candidates", "source_comments", "source_items", "fetch_runs"].map(
        (table) => env.DB.prepare(`DELETE FROM ${table}`),
      ),
    );
    const repository = new Repository(env.DB);
    await repository.createRun({
      id: "run-d1-retry",
      localDate: "2026-07-24",
      startedAt: now.toISOString(),
    });
    const posts = Array.from({ length: 6 }, (_, index) => sourceItem(index + 1));
    const pipelineDeps: PipelineDeps = {
      reddit: {
        listTopPosts: vi.fn(async () => posts),
        getPostWithComments: vi.fn(),
        checkItems: vi.fn(),
        checkComments: vi.fn(),
      },
      repository,
      now: () => now,
    };

    const first = await discoverCandidates(pipelineDeps, "run-d1-retry");
    const second = await discoverCandidates(pipelineDeps, "run-d1-retry");
    const persisted = await repository.listCandidatesForRun("run-d1-retry");

    expect(second).toEqual(first);
    expect(persisted).toHaveLength(5);
    expect(persisted.map((candidate) => candidate.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([0, 3])(
    "returns a completed %i-candidate D1 checkpoint without refetching Reddit",
    async (eligibleCount) => {
      await applyMigrations();
      await env.DB.batch(
        ["summaries", "candidates", "source_comments", "source_items", "fetch_runs"].map(
          (table) => env.DB.prepare(`DELETE FROM ${table}`),
        ),
      );
      const repository = new Repository(env.DB);
      const runId = `run-underfilled-${eligibleCount}`;
      await repository.createRun({
        id: runId,
        localDate: `2026-07-${20 + eligibleCount}`,
        startedAt: now.toISOString(),
      });
      const posts = Array.from({ length: eligibleCount }, (_, index) =>
        sourceItem(index + 1),
      );
      const listTopPosts = vi.fn(async () => posts);
      const pipelineDeps: PipelineDeps = {
        reddit: {
          listTopPosts,
          getPostWithComments: vi.fn(),
          checkItems: vi.fn(),
          checkComments: vi.fn(),
        },
        repository,
        now: () => now,
      };

      const first = await discoverCandidates(pipelineDeps, runId);
      const second = await discoverCandidates(pipelineDeps, runId);

      expect(second).toEqual(first);
      expect(second.selected).toBe(eligibleCount);
      expect(listTopPosts).toHaveBeenCalledTimes(1);
    },
  );
});

function candidateFor(runId: string, itemId: string, rank: number): Candidate {
  return {
    id: `${runId}:${itemId}`,
    runId,
    itemId,
    score: 90,
    reasons: ["existing"],
    rank,
    status: "selected",
    selectedAt: now.toISOString(),
  };
}
