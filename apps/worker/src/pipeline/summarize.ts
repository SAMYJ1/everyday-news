import type { KnowledgeCardRecord } from "../domain";
import {
  CARD_MODEL,
  InvalidCardResponse,
  type CardGenerator,
} from "../ai/workers-ai";
import type { PipelineDeps } from "./discover";

export const PROMPT_VERSION = "v1";
export const SUMMARY_CLAIM_LEASE_MS = 10 * 60 * 1_000;

export class SummaryClaimUnavailable extends Error {
  constructor() {
    super("Candidate summarization is already in progress");
    this.name = "SummaryClaimUnavailable";
  }
}

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function summarizeCandidate(
  deps: PipelineDeps & { generator: CardGenerator },
  runId: string,
  itemId: string
): Promise<void> {
  const candidate = await deps.repository.getCandidate(runId, itemId);
  if (candidate === null) throw new Error(`Candidate not found for run ${runId} and item ${itemId}`);

  const [item, comments] = await Promise.all([
    deps.repository.getSourceItem(itemId),
    deps.repository.listComments(itemId)
  ]);
  if (item === null) throw new Error(`Source item not found: ${itemId}`);

  const inputHash = await sha256(JSON.stringify({ item, comments, promptVersion: PROMPT_VERSION }));
  const claimedAt = deps.now?.() ?? new Date();
  const staleBefore = new Date(
    claimedAt.getTime() - SUMMARY_CLAIM_LEASE_MS,
  );
  const claimToken = crypto.randomUUID();
  const claimed = await deps.repository.claimCandidateForSummary(
    candidate.id,
    claimToken,
    claimedAt.toISOString(),
    staleBefore.toISOString(),
  );
  if (!claimed) throw new SummaryClaimUnavailable();

  const existing = await deps.repository.getSuccessfulSummary(
    candidate.id,
    PROMPT_VERSION,
    inputHash,
  );
  if (existing !== null) {
    await deps.repository.completeSummaryClaim(
      candidate.id,
      claimToken,
      "summarized",
    );
    return;
  }

  const base: Pick<KnowledgeCardRecord, "id" | "candidateId" | "model" | "promptVersion" | "inputHash" | "generatedAt"> = {
    id: `summary-${candidate.id}-${inputHash}`,
    candidateId: candidate.id,
    model: CARD_MODEL,
    promptVersion: PROMPT_VERSION,
    inputHash,
    generatedAt: claimedAt.toISOString()
  };

  let card;
  try {
    card = await deps.generator.generate({ item, comments });
  } catch (error) {
    if (!(error instanceof InvalidCardResponse)) {
      try {
        await deps.repository.releaseSummaryClaim(
          candidate.id,
          claimToken,
          candidate.status,
        );
      } catch {
        // Preserve the transport error; the lease remains recoverable after expiry.
      }
      throw error;
    }
    try {
      const saved = await deps.repository.saveSummaryForClaim({
        ...base,
        status: "failed",
        titleZh: "",
        oneLineFact: "",
        whyInteresting: "",
        commentInsights: [],
        caveats: [],
        confidenceNote: "",
      }, claimToken);
      if (!saved) {
        const preserved = await deps.repository.getSuccessfulSummary(
          candidate.id,
          PROMPT_VERSION,
          inputHash,
        );
        if (preserved !== null) {
          await deps.repository.completeSummaryClaim(
            candidate.id,
            claimToken,
            "summarized",
          );
        }
        return;
      }
      await deps.repository.completeSummaryClaim(
        candidate.id,
        claimToken,
        "failed",
      );
      return;
    } catch (persistenceError) {
      try {
        await deps.repository.releaseSummaryClaim(
          candidate.id,
          claimToken,
          candidate.status,
        );
      } catch {
        // Preserve the persistence error; the lease remains recoverable after expiry.
      }
      throw persistenceError;
    }
  }

  try {
    const saved = await deps.repository.saveSummaryForClaim(
      { ...base, ...card, status: "draft" },
      claimToken,
    );
    if (!saved) return;
    await deps.repository.completeSummaryClaim(
      candidate.id,
      claimToken,
      "summarized",
    );
  } catch (error) {
    try {
      await deps.repository.releaseSummaryClaim(
        candidate.id,
        claimToken,
        candidate.status,
      );
    } catch {
      // Preserve the persistence error; the lease remains recoverable after expiry.
    }
    throw error;
  }
}
