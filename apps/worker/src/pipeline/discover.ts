import type { Repository } from "../db/repository";
import type { Candidate } from "../domain";
import { evaluatePost } from "../ranking/score";
import type { RedditSourceAdapter } from "../reddit/adapter";

const DISCOVERY_LIMIT = 20;
const CANDIDATE_LIMIT = 5;

export interface PipelineDeps {
  reddit: RedditSourceAdapter;
  repository: Pick<
    Repository,
    "getRecentSourceUrls" | "getRecentTitles" | "upsertSourceItem" | "saveCandidate" | "replaceComments"
  >;
  now?: () => Date;
}

export async function discoverCandidates(
  deps: PipelineDeps,
  runId: string,
): Promise<{ discovered: number; selected: number; itemIds: string[] }> {
  const items = await deps.reddit.listTopPosts({ limit: DISCOVERY_LIMIT, time: "day" });
  await Promise.all(items.map((item) => deps.repository.upsertSourceItem(item)));

  const [recentUrls, recentTitles] = await Promise.all([
    deps.repository.getRecentSourceUrls(30),
    deps.repository.getRecentTitles(30),
  ]);
  const now = deps.now?.() ?? new Date();
  const candidates = items
    .map((item) => ({ item, evaluation: evaluatePost(item, { now, recentUrls, recentTitles }) }))
    .filter(({ evaluation }) => evaluation.eligible)
    .sort(
      (first, second) =>
        second.evaluation.score - first.evaluation.score || first.item.id.localeCompare(second.item.id),
    )
    .slice(0, CANDIDATE_LIMIT);

  const selectedAt = now.toISOString();
  for (const [index, { item, evaluation }] of candidates.entries()) {
    const candidate: Candidate = {
      id: `${runId}:${item.id}`,
      runId,
      itemId: item.id,
      score: evaluation.score,
      reasons: evaluation.reasons,
      rank: index + 1,
      status: "selected",
      selectedAt,
    };
    await deps.repository.saveCandidate(candidate);
  }

  return {
    discovered: items.length,
    selected: candidates.length,
    itemIds: candidates.map(({ item }) => item.id),
  };
}
