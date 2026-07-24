import { describe, expect, it } from "vitest";
import type { SourceItem } from "../src/domain";
import { evaluatePost } from "../src/ranking/score";

const now = new Date("2026-07-23T12:00:00.000Z");

function sourceItem(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    id: "item-1",
    source: "reddit",
    externalId: "t3_abc",
    title: "Researchers discover a useful fact",
    author: "alice",
    redditUrl: "https://reddit.com/r/todayilearned/comments/abc",
    sourceUrl: "https://example.test/articles/useful-fact",
    score: 100,
    upvoteRatio: 0.9,
    commentCount: 10,
    publishedAt: "2026-07-23T08:00:00.000Z",
    fetchedAt: "2026-07-23T12:00:00.000Z",
    lastCheckedAt: "2026-07-23T12:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function context(overrides: Partial<Parameters<typeof evaluatePost>[1]> = {}) {
  return {
    now,
    recentUrls: new Set<string>(),
    recentTitles: [],
    ...overrides
  };
}

describe("evaluatePost", () => {
  it.each<[string, Partial<SourceItem>, boolean, Partial<Parameters<typeof evaluatePost>[1]>]>([
    ["sticky", { stickied: true }, false, {}],
    ["nsfw", { over18: true }, false, {}],
    ["deleted", { deleted: true }, false, {}],
    ["no external source", { sourceUrl: null }, false, {}],
    [
      "duplicate URL in 30 days",
      {},
      false,
      { recentUrls: new Set(["https://example.test/articles/useful-fact"]) }
    ],
    ["eligible high discussion", { score: 1500, commentCount: 200 }, true, {}]
  ])("marks %s posts as eligible: %s", (_name, overrides, eligible, contextOverrides) => {
    expect(evaluatePost(sourceItem(overrides), context(contextOverrides)).eligible).toBe(eligible);
  });

  it("returns a deterministic rounded score and ordered reasons", () => {
    const item = sourceItem({ score: 1000, commentCount: 100, upvoteRatio: 0.75 });

    const first = evaluatePost(item, context());
    const second = evaluatePost(item, context());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      eligible: true,
      score: 71,
      reasons: ["engagement: 30", "discussion: 20", "freshness: 16", "ratio: 5"]
    });
  });

  it("normalizes equivalent source URLs before checking duplicates", () => {
    const result = evaluatePost(
      sourceItem({ sourceUrl: "HTTPS://EXAMPLE.TEST/articles/useful-fact/#section" }),
      context({ recentUrls: new Set(["https://example.test/articles/useful-fact"]) })
    );

    expect(result).toMatchObject({ eligible: false, score: 0, exclusion: "duplicate_url" });
  });

  it("excludes titles with Jaccard similarity at or above 0.85", () => {
    const result = evaluatePost(
      sourceItem({ title: "Researchers discover a useful fact" }),
      context({ recentTitles: ["Researchers discover useful a fact"] })
    );

    expect(result).toMatchObject({ eligible: false, score: 0, exclusion: "similar_title" });
  });
});
