import type { SourceComment } from "../domain";
import type { PipelineDeps } from "./discover";

const COMMENT_LIMIT = 20;

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

export async function collectComments(
  deps: PipelineDeps,
  _runId: string,
  itemId: string,
): Promise<{ stored: number }> {
  const { comments } = await deps.reddit.getPostWithComments(itemId, { limit: COMMENT_LIMIT, depth: 2 });
  const commentsByBody = new Map<string, SourceComment>();
  for (const comment of comments) {
    if (!isUseful(comment)) continue;
    const body = normalizedBody(comment.body);
    const existing = commentsByBody.get(body);
    if (
      existing === undefined ||
      comment.score > existing.score ||
      (comment.score === existing.score && comment.id.localeCompare(existing.id) < 0)
    ) {
      commentsByBody.set(body, comment);
    }
  }
  const usefulComments = [...commentsByBody.values()]
    .sort((first, second) => second.score - first.score || first.id.localeCompare(second.id))
    .slice(0, COMMENT_LIMIT);

  await deps.repository.replaceComments(itemId, usefulComments);
  return { stored: usefulComments.length };
}
