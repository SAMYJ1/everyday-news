import { describe, expect, it, vi } from "vitest";
import type { SourceComment, SourceItem } from "../src/domain";
import { collectComments } from "../src/pipeline/comments";
import type { PipelineDeps } from "../src/pipeline/discover";

const now = "2026-07-24T00:00:00.000Z";

function comment(index: number, overrides: Partial<SourceComment> = {}): SourceComment {
  const externalId = `t1_comment${index}`;
  return {
    id: externalId,
    itemId: "t3_post1",
    externalId,
    parentExternalId: "t3_post1",
    author: "commenter",
    body: `This is a useful comment with enough context number ${index}.`,
    score: index,
    depth: 0,
    redditUrl: `https://reddit.com/r/todayilearned/comments/post1/comment${index}`,
    publishedAt: now,
    fetchedAt: now,
    deletedAt: null,
    deleted: false,
    ...overrides
  };
}

function deps(comments: SourceComment[]): {
  deps: PipelineDeps;
  getPostWithComments: ReturnType<typeof vi.fn>;
  replaceComments: ReturnType<typeof vi.fn>;
} {
  const getPostWithComments = vi.fn(async () => ({
    item: { id: "t3_post1" } as SourceItem,
    comments
  }));
  const replaceComments = vi.fn(async () => undefined);

  return {
    deps: {
      reddit: {
        listTopPosts: vi.fn(),
        getPostWithComments,
        checkItems: vi.fn()
      },
      repository: { replaceComments }
    } as unknown as PipelineDeps,
    getPostWithComments,
    replaceComments
  };
}

describe("collectComments", () => {
  it("keeps useful unique comments ordered by score and excludes deleted, low-information, and bot entries", async () => {
    const valid = [comment(1, { score: 10 }), comment(2, { score: 90 }), comment(3, { score: 50 })];
    const { deps: pipelineDeps, getPostWithComments, replaceComments } = deps([
      valid[0],
      comment(4, { body: "[deleted]", deleted: true, deletedAt: now }),
      comment(5, { body: "Too short" }),
      comment(6, { body: "I am a bot and this action was performed automatically.", score: 100 }),
      valid[1],
      comment(7, { body: "  this is a useful comment with enough context number 2.  ", score: 95 }),
      valid[2]
    ]);

    const result = await collectComments(pipelineDeps, "run-1", "t3_post1");

    expect(getPostWithComments).toHaveBeenCalledWith("t3_post1", { limit: 20, depth: 2 });
    expect(result).toEqual({ stored: 3 });
    expect(replaceComments).toHaveBeenCalledWith("t3_post1", [
      expect.objectContaining({ id: "t1_comment7", score: 95 }),
      valid[2],
      valid[0],
    ]);
  });

  it("stores no more than twenty useful unique comments", async () => {
    const comments = Array.from({ length: 25 }, (_, index) => comment(index + 1, { score: index + 1 }));
    const { deps: pipelineDeps, replaceComments } = deps(comments);

    const result = await collectComments(pipelineDeps, "run-2", "t3_post1");

    expect(result).toEqual({ stored: 20 });
    expect(replaceComments).toHaveBeenCalledWith("t3_post1", comments.slice(5).reverse());
  });
});
