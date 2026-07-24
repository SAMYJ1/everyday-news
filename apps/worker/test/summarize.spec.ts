import { describe, expect, it, vi } from "vitest";
import type { CardGenerator } from "../src/ai/workers-ai";
import type { Candidate, KnowledgeCardRecord, SourceComment, SourceItem } from "../src/domain";
import { summarizeCandidate } from "../src/pipeline/summarize";
import type { PipelineDeps } from "../src/pipeline/discover";

const timestamp = "2026-07-24T00:00:00.000Z";
const item: SourceItem = {
  id: "t3_post1", source: "reddit", externalId: "t3_post1", title: "English title", author: "author",
  redditUrl: "https://reddit.com/post1", sourceUrl: "https://example.test/source", score: 10,
  upvoteRatio: 0.9, commentCount: 1, publishedAt: timestamp, fetchedAt: timestamp,
  lastCheckedAt: timestamp, deletedAt: null
};
const comment: SourceComment = {
  id: "t1_comment1", itemId: item.id, externalId: "t1_comment1", parentExternalId: item.externalId,
  author: "commenter", body: "Useful context from a comment.", score: 2, depth: 0,
  redditUrl: "https://reddit.com/comment1", publishedAt: timestamp, fetchedAt: timestamp,
  deletedAt: null, deleted: false
};
const candidate: Candidate = {
  id: "candidate-1", runId: "run-1", itemId: item.id, score: 10, reasons: [], rank: 1,
  status: "comments_ready", selectedAt: timestamp
};
const card = {
  titleZh: "中文标题", oneLineFact: "原帖声称一件事。", whyInteresting: "值得一读。",
  commentInsights: ["评论补充。"], caveats: ["存在局限。"], confidenceNote: "仅来自帖子和评论。"
};

function deps(existing: KnowledgeCardRecord | null = null): {
  deps: PipelineDeps & { generator: CardGenerator };
  generate: ReturnType<typeof vi.fn>;
  saveSummary: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(async () => card);
  const saveSummary = vi.fn(async () => undefined);
  return {
    deps: {
      reddit: {} as PipelineDeps["reddit"],
      repository: {
        getCandidate: vi.fn(async () => candidate),
        getSourceItem: vi.fn(async () => item),
        listComments: vi.fn(async () => [comment]),
        getSuccessfulSummary: vi.fn(async () => existing),
        saveSummary
      } as unknown as PipelineDeps["repository"],
      generator: { generate },
      now: () => new Date(timestamp)
    },
    generate,
    saveSummary
  };
}

describe("summarizeCandidate", () => {
  it("saves a generated card as a draft", async () => {
    const { deps: pipelineDeps, generate, saveSummary } = deps();

    await summarizeCandidate(pipelineDeps, candidate.runId, item.id);

    expect(generate).toHaveBeenCalledWith({ item, comments: [comment] });
    expect(saveSummary).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: candidate.id, status: "draft", ...card, model: "@cf/meta/llama-3.1-8b-instruct-fast",
      promptVersion: "v1", inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), generatedAt: timestamp
    }));
  });

  it("does not call AI or save another card when the input already succeeded", async () => {
    const existing: KnowledgeCardRecord = {
      id: "summary-1", candidateId: candidate.id, status: "draft", ...card,
      model: "@cf/meta/llama-3.1-8b-instruct-fast", promptVersion: "v1", inputHash: "hash", generatedAt: timestamp
    };
    const { deps: pipelineDeps, generate, saveSummary } = deps(existing);

    await summarizeCandidate(pipelineDeps, candidate.runId, item.id);

    expect(generate).not.toHaveBeenCalled();
    expect(saveSummary).not.toHaveBeenCalled();
  });

  it("records a failed summary when both model attempts are malformed", async () => {
    const { deps: pipelineDeps, saveSummary } = deps();
    pipelineDeps.generator.generate = vi.fn(async () => { throw new Error("Malformed card"); });

    await summarizeCandidate(pipelineDeps, candidate.runId, item.id);

    expect(saveSummary).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: candidate.id, status: "failed", model: "@cf/meta/llama-3.1-8b-instruct-fast", promptVersion: "v1"
    }));
  });
});
