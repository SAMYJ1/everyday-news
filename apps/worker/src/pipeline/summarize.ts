import type { Candidate, KnowledgeCardRecord } from "../domain";
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

async function terminalizeRejectedSummary(
  deps: PipelineDeps,
  candidate: Candidate,
  claimToken: string,
  inputHash: string,
  regeneration: { id: string; nonce: string } | null | undefined,
  completedAt: string,
): Promise<void> {
  const existing = regeneration === undefined || regeneration === null
    ? await deps.repository.getSuccessfulSummary(
        candidate.id,
        PROMPT_VERSION,
        inputHash,
      )
    : null;
  const completed = await deps.repository.completeSummaryClaim(
    candidate.id,
    claimToken,
    existing === null ? "failed" : "summarized",
  );
  if (completed && regeneration !== undefined && regeneration !== null) {
    await deps.repository.completeCardRegeneration(
      regeneration.id,
      regeneration.nonce,
      completedAt,
    );
  }
}

export async function summarizeCandidate(
  deps: PipelineDeps & { generator: CardGenerator },
  runId: string,
  itemId: string,
  regeneration?: { id: string; nonce: string },
): Promise<void> {
  const candidate = await deps.repository.getCandidate(runId, itemId);
  if (candidate === null) throw new Error(`Candidate not found for run ${runId} and item ${itemId}`);

  const [item, comments] = await Promise.all([
    deps.repository.getSourceItem(itemId),
    deps.repository.listComments(itemId)
  ]);
  if (item === null) throw new Error(`Source item not found: ${itemId}`);

  const requestedRegeneration = regeneration === undefined
    ? await deps.repository.getActiveCardRegeneration(candidate.id)
    : regeneration;
  const regenerationRequest = requestedRegeneration === null
    ? null
    : requestedRegeneration === undefined
    ? null
    : await deps.repository.getPendingCardRegeneration(requestedRegeneration.id, requestedRegeneration.nonce, candidate.id);
  if (requestedRegeneration !== undefined && requestedRegeneration !== null && regenerationRequest === null) return;
  const inputHash = await sha256(JSON.stringify({ item, comments, promptVersion: PROMPT_VERSION, regenerationNonce: requestedRegeneration?.nonce }));
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

  const existing = requestedRegeneration === undefined || requestedRegeneration === null
    ? await deps.repository.getSuccessfulSummary(
        candidate.id,
        PROMPT_VERSION,
        inputHash,
      )
    : null;
  if (existing !== null) {
    await deps.repository.completeSummaryClaim(
      candidate.id,
      claimToken,
      "summarized",
    );
    if (requestedRegeneration !== undefined && requestedRegeneration !== null) await deps.repository.completeCardRegeneration(requestedRegeneration.id, requestedRegeneration.nonce, claimedAt.toISOString());
    return;
  }

  const base: Pick<KnowledgeCardRecord, "id" | "candidateId" | "model" | "promptVersion" | "inputHash" | "generatedAt"> = {
    id: regenerationRequest?.summaryId ?? `summary-${candidate.id}-${inputHash}`,
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
        await terminalizeRejectedSummary(
          deps,
          candidate,
          claimToken,
          inputHash,
          requestedRegeneration,
          claimedAt.toISOString(),
        );
        return;
      }
      await deps.repository.completeSummaryClaim(
        candidate.id,
        claimToken,
        "failed",
      );
      if (requestedRegeneration !== undefined && requestedRegeneration !== null) await deps.repository.completeCardRegeneration(requestedRegeneration.id, requestedRegeneration.nonce, claimedAt.toISOString());
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
    if (!saved) {
      await terminalizeRejectedSummary(
        deps,
        candidate,
        claimToken,
        inputHash,
        requestedRegeneration,
        claimedAt.toISOString(),
      );
      return;
    }
    await deps.repository.completeSummaryClaim(
      candidate.id,
      claimToken,
      "summarized",
    );
    if (requestedRegeneration !== undefined && requestedRegeneration !== null) await deps.repository.completeCardRegeneration(requestedRegeneration.id, requestedRegeneration.nonce, claimedAt.toISOString());
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
