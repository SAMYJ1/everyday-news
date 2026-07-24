import { describe, expect, it, vi } from "vitest";
import type { Candidate, SourceItem } from "../src/domain";
import { discoverCandidates, type PipelineDeps } from "../src/pipeline/discover";

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
        checkItems: vi.fn()
      },
      repository: {
        getRecentSourceUrls: vi.fn(async () => recentUrls),
        getRecentTitles: vi.fn(async () => []),
        upsertSourceItem,
        saveCandidate
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
});
