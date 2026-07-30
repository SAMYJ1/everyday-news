import commentsFixture from "./fixtures/reddit-comments.atom?raw";
import hotFixture from "./fixtures/reddit-hot.atom?raw";
import { describe, expect, it } from "vitest";
import { parseAtomPosts, parseAtomThread } from "../src/reddit/rss-parser";

const fetchedAt = new Date("2026-07-30T05:00:00.000Z");

describe("Reddit Atom parser", () => {
  it("maps hot-feed posts without inventing Reddit engagement metrics", () => {
    const posts = parseAtomPosts(hotFixture, fetchedAt);

    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      id: "t3_abc123",
      author: "researcher",
      title: "TIL an example fact & its context",
      redditUrl:
        "https://www.reddit.com/r/todayilearned/comments/abc123/example/",
      sourceUrl: "https://example.org/article?one=1&two=2",
      score: 0,
      upvoteRatio: null,
      commentCount: 0,
      sourceRank: 1,
      publishedAt: "2026-07-30T03:59:37.000Z",
      fetchedAt: fetchedAt.toISOString(),
    });
    expect(posts[1]).toMatchObject({
      id: "t3_def456",
      sourceUrl: null,
      sourceRank: 2,
    });
  });

  it("maps a thread post and flat comment entries without claiming reply depth or votes", () => {
    const result = parseAtomThread(commentsFixture, fetchedAt);

    expect(result.item).toMatchObject({
      id: "t3_abc123",
      sourceUrl: "https://example.org/article",
      commentCount: 2,
    });
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({
      id: "t1_comment1",
      itemId: "t3_abc123",
      parentExternalId: null,
      author: "informative",
      body:
        "The technology mattered, but adoption took decades.\nAccording to contemporary research, household equipment and distribution infrastructure were also necessary.",
      score: 0,
      depth: 0,
      sourceRank: 1,
      deleted: false,
    });
    expect(result.comments[1]?.body).toBe("Nice one & funny.");
  });
});
