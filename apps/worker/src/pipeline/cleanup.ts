import type { Repository } from "../db/repository";
import type { PipelineDeps } from "./discover";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RECENT_WINDOW_MS = 2 * DAY_MS;
const HISTORY_RECHECK_MS = 7 * DAY_MS;

export type AccessFailureCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "challenge";

const ACCESS_FAILURE_CODES = new Set<AccessFailureCode>([
  "unauthorized",
  "forbidden",
  "rate_limited",
  "challenge",
]);

export async function syncSourceState(
  deps: PipelineDeps,
  now: Date,
): Promise<{ checked: number; removed: number }> {
  const checkedAt = now.toISOString();
  const items = await deps.repository.listSourceItemsForCleanup({
    recentSince: new Date(now.getTime() - RECENT_WINDOW_MS).toISOString(),
    dailyBefore: new Date(now.getTime() - DAY_MS).toISOString(),
    weeklyBefore: new Date(now.getTime() - HISTORY_RECHECK_MS).toISOString(),
  });
  if (items.length === 0) return { checked: 0, removed: 0 };

  const byExternalId = new Map(
    items.map((item) => [item.externalId, item]),
  );
  const results = await deps.reddit.checkItems(
    items.map((item) => item.externalId),
  );
  let checked = 0;
  let removed = 0;

  for (const result of results) {
    const item = byExternalId.get(result.id);
    if (item === undefined) continue;
    checked += 1;
    if (result.deleted) {
      await deps.repository.removeDeletedSourceItem(item.id, checkedAt);
      removed += 1;
    } else {
      await deps.repository.markSourceItemChecked(item.id, checkedAt);
    }
  }

  return { checked, removed };
}

export async function recordAccessFailure(
  repository: Repository,
  code: AccessFailureCode,
  at: string,
): Promise<{ consecutiveFailures: number; anonymousEnabled: boolean }> {
  if (!ACCESS_FAILURE_CODES.has(code)) {
    throw new TypeError(`Unsupported Reddit access failure code: ${code}`);
  }
  const state = await repository.recordAnonymousFailure(at);
  return {
    consecutiveFailures: state.consecutiveFailures,
    anonymousEnabled: state.enabled,
  };
}
