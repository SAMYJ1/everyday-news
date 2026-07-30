import type { SourceComment } from "../domain";
import type { PipelineDeps } from "./discover";

const COMMENT_FETCH_LIMIT = 100;
const COMMENT_STORE_LIMIT = 20;

function normalizedBody(body: string): string {
  return body.trim().replace(/\s+/g, " ").toLowerCase();
}

function isUseful(comment: SourceComment): boolean {
  const body = comment.body.trim();
  return (
    !comment.deleted &&
    body.length >= 20 &&
    !/^(i am a bot|this action was performed automatically)/i.test(body)
  );
}

function informationValue(comment: SourceComment): number {
  const body = comment.body.trim();
  const sentenceCount = body.match(/[.!?](?:\s|$)/g)?.length ?? 0;
  const detailSignals = body.match(
    /\b(?:according|because|during|evidence|however|research|source|study|until|whereas)\b/gi,
  )?.length ?? 0;
  return (
    Math.min(body.length, 1_000) +
    Math.min(sentenceCount, 6) * 40 +
    Math.min(detailSignals, 4) * 60
  );
}

function compareComments(first: SourceComment, second: SourceComment): number {
  const scoreOrder = second.score - first.score;
  if (first.score !== 0 || second.score !== 0) {
    return scoreOrder || first.id.localeCompare(second.id);
  }
  return (
    informationValue(second) - informationValue(first) ||
    (first.sourceRank ?? Number.MAX_SAFE_INTEGER) -
      (second.sourceRank ?? Number.MAX_SAFE_INTEGER) ||
    first.id.localeCompare(second.id)
  );
}

export async function collectComments(
  deps: PipelineDeps,
  _runId: string,
  itemId: string,
): Promise<{ stored: number }> {
  const { comments } = await deps.reddit.getPostWithComments(itemId, {
    limit: COMMENT_FETCH_LIMIT,
    depth: 2,
  });
  const commentsByBody = new Map<string, SourceComment>();
  for (const comment of comments) {
    if (!isUseful(comment)) continue;
    const body = normalizedBody(comment.body);
    const existing = commentsByBody.get(body);
    if (
      existing === undefined ||
      compareComments(comment, existing) < 0
    ) {
      commentsByBody.set(body, comment);
    }
  }
  const usefulComments = [...commentsByBody.values()]
    .sort(compareComments)
    .slice(0, COMMENT_STORE_LIMIT);

  await deps.repository.replaceComments(itemId, usefulComments);
  return { stored: usefulComments.length };
}
