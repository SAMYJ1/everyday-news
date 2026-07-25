import { describe, expect, it, vi } from "vitest";
import {
  InvalidCardResponse,
  type CardGenerator,
} from "../src/ai/workers-ai";
import type { Candidate, KnowledgeCardRecord, SourceComment, SourceItem } from "../src/domain";
import {
  summarizeCandidate,
  SummaryClaimUnavailable,
} from "../src/pipeline/summarize";
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
  saveSummaryForClaim: ReturnType<typeof vi.fn>;
  completeSummaryClaim: ReturnType<typeof vi.fn>;
  releaseSummaryClaim: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(async () => card);
  const saveSummaryForClaim = vi.fn(async () => true);
  const completeSummaryClaim = vi.fn(async () => true);
  const releaseSummaryClaim = vi.fn(async () => true);
  return {
    deps: {
      reddit: {} as PipelineDeps["reddit"],
      repository: {
        getCandidate: vi.fn(async () => candidate),
        getSourceItem: vi.fn(async () => item),
        listComments: vi.fn(async () => [comment]),
        getSuccessfulSummary: vi.fn(async () => existing),
        getActiveCardRegeneration: vi.fn(async () => null),
        getPendingCardRegeneration: vi.fn(async () => null),
        completeCardRegeneration: vi.fn(async () => undefined),
        saveSummaryForClaim,
        claimCandidateForSummary: vi.fn(async () => true),
        completeSummaryClaim,
        releaseSummaryClaim,
      } as unknown as PipelineDeps["repository"],
      generator: { generate },
      now: () => new Date(timestamp)
    },
    generate,
    saveSummaryForClaim,
    completeSummaryClaim,
    releaseSummaryClaim,
  };
}

describe("summarizeCandidate", () => {
  it("saves a generated card as a draft", async () => {
    const {
      deps: pipelineDeps,
      generate,
      saveSummaryForClaim,
      completeSummaryClaim,
    } = deps();

    await summarizeCandidate(pipelineDeps, candidate.runId, item.id);

    const claimToken = (
      pipelineDeps.repository.claimCandidateForSummary as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as string;
    expect(generate).toHaveBeenCalledWith({ item, comments: [comment] });
    expect(saveSummaryForClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: candidate.id, status: "draft", ...card, model: "@cf/meta/llama-3.1-8b-instruct-fast",
        promptVersion: "v1", inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), generatedAt: timestamp
      }),
      claimToken,
    );
    expect(completeSummaryClaim).toHaveBeenLastCalledWith(
      candidate.id,
      claimToken,
      "summarized",
    );
  });

  it("does not call AI or save another card when the input already succeeded", async () => {
    const existing: KnowledgeCardRecord = {
      id: "summary-1", candidateId: candidate.id, status: "draft", ...card,
      model: "@cf/meta/llama-3.1-8b-instruct-fast", promptVersion: "v1", inputHash: "hash", generatedAt: timestamp
    };
    const { deps: pipelineDeps, generate, saveSummaryForClaim, completeSummaryClaim } =
      deps(existing);

    await summarizeCandidate(pipelineDeps, candidate.runId, item.id);

    const claimToken = (
      pipelineDeps.repository.claimCandidateForSummary as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as string;
    expect(generate).not.toHaveBeenCalled();
    expect(saveSummaryForClaim).not.toHaveBeenCalled();
    expect(completeSummaryClaim).toHaveBeenCalledWith(
      candidate.id,
      claimToken,
      "summarized",
    );
  });

  it("records a failed summary when both model attempts are malformed", async () => {
    const { deps: pipelineDeps, saveSummaryForClaim, completeSummaryClaim } = deps();
    pipelineDeps.generator.generate = vi.fn(async () => {
      throw new InvalidCardResponse("Malformed card");
    });

    await summarizeCandidate(pipelineDeps, candidate.runId, item.id);

    const claimToken = (
      pipelineDeps.repository.claimCandidateForSummary as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as string;
    expect(saveSummaryForClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: candidate.id, status: "failed", model: "@cf/meta/llama-3.1-8b-instruct-fast", promptVersion: "v1"
      }),
      claimToken,
    );
    expect(completeSummaryClaim).toHaveBeenCalledWith(
      candidate.id,
      claimToken,
      "failed",
    );
  });

  it("does not mark a preserved successful summary as failed", async () => {
    const existing: KnowledgeCardRecord = {
      id: "summary-1", candidateId: candidate.id, status: "draft", ...card,
      model: "@cf/meta/llama-3.1-8b-instruct-fast", promptVersion: "v1", inputHash: "hash", generatedAt: timestamp
    };
    const { deps: pipelineDeps, saveSummaryForClaim, completeSummaryClaim } = deps();
    pipelineDeps.generator.generate = vi.fn(async () => {
      throw new InvalidCardResponse("Malformed card");
    });
    saveSummaryForClaim.mockResolvedValue(false);
    pipelineDeps.repository.getSuccessfulSummary = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);

    await summarizeCandidate(pipelineDeps, candidate.runId, item.id);

    const claimToken = (
      pipelineDeps.repository.claimCandidateForSummary as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as string;
    expect(completeSummaryClaim).toHaveBeenCalledWith(
      candidate.id,
      claimToken,
      "summarized",
    );
  });

  it("rethrows transport failures, releases the claim, and does not save failed output", async () => {
    const failure = new Error("Workers AI unavailable");
    const { deps: pipelineDeps, saveSummaryForClaim, releaseSummaryClaim } = deps();
    pipelineDeps.generator.generate = vi.fn(async () => {
      throw failure;
    });

    await expect(
      summarizeCandidate(pipelineDeps, candidate.runId, item.id),
    ).rejects.toBe(failure);

    const claimToken = (
      pipelineDeps.repository.claimCandidateForSummary as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as string;
    expect(saveSummaryForClaim).not.toHaveBeenCalled();
    expect(releaseSummaryClaim).toHaveBeenCalledWith(
      candidate.id,
      claimToken,
      candidate.status,
    );
  });

  it("allows only the delivery that atomically claims the candidate to call AI", async () => {
    const { deps: pipelineDeps, generate } = deps();
    const claim = pipelineDeps.repository.claimCandidateForSummary as ReturnType<
      typeof vi.fn
    >;
    claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const results = await Promise.allSettled([
      summarizeCandidate(pipelineDeps, candidate.runId, item.id),
      summarizeCandidate(pipelineDeps, candidate.runId, item.id),
    ]);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: expect.any(SummaryClaimUnavailable) });
  });

  it("can claim a summarized candidate when changed input has no matching hash", async () => {
    const changedCandidate = { ...candidate, status: "summarized" as const };
    const { deps: pipelineDeps, generate } = deps();
    pipelineDeps.repository.getCandidate = vi.fn(async () => changedCandidate);

    await summarizeCandidate(pipelineDeps, candidate.runId, item.id);

    expect(pipelineDeps.repository.claimCandidateForSummary).toHaveBeenCalledWith(
      candidate.id,
      expect.any(String),
      timestamp,
      "2026-07-23T23:50:00.000Z",
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("rethrows draft persistence failures instead of recording a failed model output", async () => {
    const failure = new Error("D1 write failed");
    const { deps: pipelineDeps, saveSummaryForClaim, releaseSummaryClaim } = deps();
    saveSummaryForClaim.mockRejectedValue(failure);

    await expect(
      summarizeCandidate(pipelineDeps, candidate.runId, item.id),
    ).rejects.toBe(failure);

    const claimToken = (
      pipelineDeps.repository.claimCandidateForSummary as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as string;
    expect(saveSummaryForClaim).toHaveBeenCalledTimes(1);
    expect(releaseSummaryClaim).toHaveBeenCalledWith(
      candidate.id,
      claimToken,
      candidate.status,
    );
  });
});
