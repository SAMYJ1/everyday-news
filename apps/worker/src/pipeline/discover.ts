import type { Repository } from "../db/repository";
import type { Candidate } from "../domain";
import { evaluatePost, normalizeSourceUrl } from "../ranking/score";
import type { RedditSourceAdapter } from "../reddit/adapter";

const DISCOVERY_LIMIT = 20;
const CANDIDATE_LIMIT = 5;

export interface PipelineDeps {
  reddit: RedditSourceAdapter;
  repository: Pick<
    Repository,
    | "getRecentSourceUrls"
    | "getRecentTitles"
    | "upsertSourceItem"
    | "saveCandidate"
    | "listCandidatesForRun"
    | "getDiscoveryCheckpoint"
    | "completeDiscovery"
    | "replaceComments"
    | "getCandidate"
    | "getSourceItem"
    | "listComments"
    | "getSuccessfulSummary"
    | "saveSummaryForClaim"
    | "claimCandidateForSummary"
    | "completeSummaryClaim"
    | "releaseSummaryClaim"
    | "getPendingCardRegeneration"
    | "completeCardRegeneration"
    | "getActiveCardRegeneration"
    | "listSourceItemsForCleanup"
    | "markSourceItemChecked"
    | "removeDeletedSourceItem"
    | "removeDeletedSourceComment"
  >;
  now?: () => Date;
  onDiscoveryRequestSucceeded?: (at: Date) => Promise<void>;
}

export async function discoverCandidates(
  deps: PipelineDeps,
  runId: string,
): Promise<{ discovered: number; selected: number; itemIds: string[] }> {
  const checkpoint = await deps.repository.getDiscoveryCheckpoint(runId);
  if (checkpoint !== null) return checkpoint;

  const items = await deps.reddit.listTopPosts({ limit: DISCOVERY_LIMIT, time: "day" });
  await deps.onDiscoveryRequestSucceeded?.(deps.now?.() ?? new Date());
  const uniqueItems = [
    ...new Map(items.map((item) => [item.externalId, item])).values(),
  ];
  for (const item of uniqueItems) {
    await deps.repository.upsertSourceItem(item);
  }

  const existing = await deps.repository.listCandidatesForRun(runId);
  if (existing.length >= CANDIDATE_LIMIT) {
    const result = {
      discovered: uniqueItems.length,
      selected: existing.length,
      itemIds: existing.map((candidate) => candidate.itemId),
    };
    await deps.repository.completeDiscovery(
      runId,
      result,
      (deps.now?.() ?? new Date()).toISOString(),
    );
    return result;
  }

  const [recentUrls, recentTitles] = await Promise.all([
    deps.repository.getRecentSourceUrls(30),
    deps.repository.getRecentTitles(30),
  ]);
  const now = deps.now?.() ?? new Date();
  const existingItemIds = new Set(existing.map((candidate) => candidate.itemId));
  const ranked = uniqueItems
    .filter((item) => !existingItemIds.has(item.id))
    .map((item) => ({ item, evaluation: evaluatePost(item, { now, recentUrls, recentTitles }) }))
    .filter(({ evaluation }) => evaluation.eligible)
    .sort(
      (first, second) =>
        second.evaluation.score - first.evaluation.score || first.item.id.localeCompare(second.item.id),
    );
  const seenUrls = new Set<string>();
  const candidates = ranked.filter(({ item }) => {
    const sourceUrl = item.sourceUrl;
    if (sourceUrl === null) return false;
    const normalized = normalizeSourceUrl(sourceUrl);
    if (seenUrls.has(normalized)) return false;
    seenUrls.add(normalized);
    return true;
  }).slice(0, CANDIDATE_LIMIT - existing.length);

  const selectedAt = now.toISOString();
  for (const [index, { item, evaluation }] of candidates.entries()) {
    const candidate: Candidate = {
      id: `${runId}:${item.id}`,
      runId,
      itemId: item.id,
      score: evaluation.score,
      reasons: evaluation.reasons,
      rank: existing.length + index + 1,
      status: "selected",
      selectedAt,
    };
    await deps.repository.saveCandidate(candidate);
  }

  const result = {
    discovered: uniqueItems.length,
    selected: existing.length + candidates.length,
    itemIds: [
      ...existing.map((candidate) => candidate.itemId),
      ...candidates.map(({ item }) => item.id),
    ],
  };
  await deps.repository.completeDiscovery(runId, result, selectedAt);
  return result;
}
