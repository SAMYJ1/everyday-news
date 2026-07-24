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
  const seenBodies = new Set<string>();
  const usefulComments = comments
    .filter((comment) => {
      if (!isUseful(comment)) return false;
      const body = normalizedBody(comment.body);
      if (seenBodies.has(body)) return false;
      seenBodies.add(body);
      return true;
    })
    .sort((first, second) => second.score - first.score || first.id.localeCompare(second.id))
    .slice(0, COMMENT_LIMIT);

  await deps.repository.replaceComments(itemId, usefulComments);
  return { stored: usefulComments.length };
}
