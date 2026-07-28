import { describe, expect, it, vi } from "vitest";
import type { SourceComment, SourceItem } from "../src/domain";
import { KnowledgeCardSchema } from "../src/ai/card-schema";
import {
  InvalidCardResponse,
  WorkersAiTemporaryFailure,
  WorkersAiCardGenerator,
} from "../src/ai/workers-ai";

const item: SourceItem = {
  id: "t3_post1",
  source: "reddit",
  externalId: "t3_post1",
  title: "A remarkable English source title",
  author: "author",
  redditUrl: "https://reddit.com/r/todayilearned/comments/post1",
  sourceUrl: "https://example.test/source",
  score: 100,
  upvoteRatio: 0.9,
  commentCount: 2,
  publishedAt: "2026-07-24T00:00:00.000Z",
  fetchedAt: "2026-07-24T00:00:00.000Z",
  lastCheckedAt: "2026-07-24T00:00:00.000Z",
  deletedAt: null
};

const comments: SourceComment[] = [
  {
    id: "t1_comment1",
    itemId: item.id,
    externalId: "t1_comment1",
    parentExternalId: item.externalId,
    author: "commenter",
    body: "This comment adds useful context.",
    score: 20,
    depth: 0,
    redditUrl: "https://reddit.com/r/todayilearned/comments/post1/comment1",
    publishedAt: "2026-07-24T00:00:00.000Z",
    fetchedAt: "2026-07-24T00:00:00.000Z",
    deletedAt: null,
    deleted: false
  }
];

const validCard = {
  titleZh: "一条中文标题",
  oneLineFact: "原帖声称这里有一条信息。",
  whyInteresting: "它提供了值得了解的背景。",
  commentInsights: ["评论补充了一点背景。"],
  caveats: ["评论也提出了保留意见。"],
  confidenceNote: "内容仅基于原帖与评论摘录。"
};

describe("KnowledgeCardSchema", () => {
  it("accepts a complete Chinese knowledge card", () => {
    expect(KnowledgeCardSchema.parse(validCard)).toEqual(validCard);
  });

  it("rejects missing fields, an English-only title, and more than three list items", () => {
    expect(() => KnowledgeCardSchema.parse({ ...validCard, confidenceNote: undefined })).toThrow();
    expect(() => KnowledgeCardSchema.parse({ ...validCard, unexpected: true })).toThrow();
    expect(() => KnowledgeCardSchema.parse({ ...validCard, titleZh: "English title only" })).toThrow();
    expect(() => KnowledgeCardSchema.parse({ ...validCard, commentInsights: ["a", "b", "c", "d"] })).toThrow();
    expect(() => KnowledgeCardSchema.parse({ ...validCard, caveats: ["a", "b", "c", "d"] })).toThrow();
  });
});

describe("WorkersAiCardGenerator", () => {
  it("frames unverified source material and repairs one malformed response", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ response: { ...validCard, titleZh: "English title only" } })
      .mockResolvedValueOnce({ response: validCard });
    const generator = new WorkersAiCardGenerator({ run } as unknown as Ai);

    await expect(generator.generate({ item, comments })).resolves.toEqual(validCard);

    expect(run).toHaveBeenCalledTimes(2);
    const [model, firstInput] = run.mock.calls[0] as [string, Record<string, unknown>];
    expect(model).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
    expect(firstInput).toMatchObject({
      temperature: 0.2,
      response_format: { type: "json_schema" }
    });
    const responseFormat = firstInput.response_format as {
      json_schema: Record<string, unknown>;
    };
    expect(responseFormat.json_schema.type).toBe("object");
    expect(responseFormat.json_schema).not.toHaveProperty("schema");
    expect(responseFormat.json_schema).not.toHaveProperty("strict");
    const prompt = String(firstInput.prompt);
    expect(prompt).toContain("原帖声称");
    expect(prompt).toContain("评论摘录 1");
    expect(prompt).toContain("不得声称已进行外部事实核查");
    expect(prompt).toContain("A remarkable English source title");
    expect(prompt).toContain(item.redditUrl);
    expect(prompt).toContain(item.sourceUrl);
    expect(String((run.mock.calls[1]?.[1] as Record<string, unknown>).prompt)).toContain("修复");
  });

  it("fails after the repair response is malformed too", async () => {
    const run = vi.fn().mockResolvedValue({ response: { titleZh: "only one field" } });
    const generator = new WorkersAiCardGenerator({ run } as unknown as Ai);

    await expect(generator.generate({ item, comments })).rejects.toBeInstanceOf(
      InvalidCardResponse,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry Workers AI transport or service failures as repair prompts", async () => {
    const failure = new Error("Workers AI quota exceeded");
    const run = vi.fn().mockRejectedValue(failure);
    const generator = new WorkersAiCardGenerator({ run } as unknown as Ai);

    await expect(generator.generate({ item, comments })).rejects.toMatchObject({
      constructor: WorkersAiTemporaryFailure,
      cause: failure,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
