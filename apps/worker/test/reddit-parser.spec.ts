import commentsFixture from "./fixtures/reddit-comments.json";
import deletedFixture from "./fixtures/reddit-deleted.json";
import topFixture from "./fixtures/reddit-top.json";
import { describe, expect, it } from "vitest";
import { parseCommentListing, parsePostListing } from "../src/reddit/parser";

describe("Reddit JSON parser", () => {
  it("maps all t3 listing entries, including optional and deletion fields", () => {
    const posts = parsePostListing(topFixture, new Date("2026-07-23T00:00:00.000Z"));

    expect(posts).toHaveLength(4);
    expect(posts[0]).toMatchObject({
      id: "t3_valid",
      externalId: "t3_valid",
      title: "TIL honey never spoils",
      sourceUrl: "https://example.org/honey",
      redditUrl:
        "https://www.reddit.com/r/todayilearned/comments/valid/til_honey_never_spoils/",
      upvoteRatio: 0.96,
      deleted: false,
    });
    expect(posts[2]?.upvoteRatio).toBeNull();
    expect(posts[3]).toMatchObject({
      author: null,
      deleted: true,
      deletedAt: "2026-07-23T00:00:00.000Z",
    });
  });

  it("flattens real comments, retaining deleted comments and ignoring more nodes", () => {
    const comments = parseCommentListing(
      commentsFixture,
      new Date("2026-07-23T00:00:00.000Z"),
    );

    expect(comments.map((comment) => comment.externalId)).toEqual([
      "t1_c1",
      "t1_c2",
      "t1_c3",
    ]);
    expect(comments[1]).toMatchObject({
      itemId: "t3_valid",
      parentExternalId: "t1_c1",
      author: null,
      body: "[deleted]",
      deleted: true,
    });
  });

  it("recognizes a deleted item listing", () => {
    expect(parsePostListing(deletedFixture)[0]?.deleted).toBe(true);
  });
});
