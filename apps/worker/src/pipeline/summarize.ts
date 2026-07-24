import type { KnowledgeCardRecord } from "../domain";
import { CARD_MODEL, type CardGenerator } from "../ai/workers-ai";
import type { PipelineDeps } from "./discover";

export const PROMPT_VERSION = "v1";

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
  const existing = await deps.repository.getSuccessfulSummary(candidate.id, PROMPT_VERSION, inputHash);
  if (existing !== null) return;

  const base: Pick<KnowledgeCardRecord, "id" | "candidateId" | "model" | "promptVersion" | "inputHash" | "generatedAt"> = {
    id: `summary-${candidate.id}-${inputHash}`,
    candidateId: candidate.id,
    model: CARD_MODEL,
    promptVersion: PROMPT_VERSION,
    inputHash,
    generatedAt: (deps.now?.() ?? new Date()).toISOString()
  };

  try {
    const card = await deps.generator.generate({ item, comments });
    await deps.repository.saveSummary({ ...base, ...card, status: "draft" });
  } catch {
    await deps.repository.saveSummary({
      ...base,
      status: "failed",
      titleZh: "",
      oneLineFact: "",
      whyInteresting: "",
      commentInsights: [],
      caveats: [],
      confidenceNote: ""
    });
  }
}
