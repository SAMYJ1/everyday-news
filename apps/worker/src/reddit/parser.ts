import type { SourceComment, SourceItem } from "../domain";

type JsonRecord = Record<string, unknown>;

const REDDIT_ORIGIN = "https://www.reddit.com";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, context: string): JsonRecord {
  if (!isRecord(value)) {
    throw new TypeError(`Invalid Reddit ${context}`);
  }
  return value;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function childrenFromListing(value: unknown): unknown[] {
  const listing = record(value, "listing");
  const data = record(listing.data, "listing data");
  if (!Array.isArray(data.children)) {
    throw new TypeError("Invalid Reddit listing children");
  }
  return data.children;
}

function toAbsoluteRedditUrl(permalink: string | null): string {
  if (!permalink) {
    throw new TypeError("Reddit item is missing a permalink");
  }
  return new URL(permalink, REDDIT_ORIGIN).toString();
}

function isoFromEpoch(value: unknown): string {
  const seconds = number(value);
  if (seconds <= 0) {
    throw new TypeError("Reddit item is missing a valid creation time");
  }
  return new Date(seconds * 1_000).toISOString();
}

function isDeletedPost(data: JsonRecord): boolean {
  return (
    data.removed_by_category === "deleted" ||
    data.title === "[deleted]" ||
    data.selftext === "[deleted]"
  );
}

function postFromChild(childValue: unknown, fetchedAt: string): SourceItem | null {
  const child = record(childValue, "post child");
  if (child.kind !== "t3") return null;
  const data = record(child.data, "post data");
  const externalId = string(data.name);
  if (!externalId?.startsWith("t3_")) {
    throw new TypeError("Reddit post is missing its fullname");
  }

  const redditUrl = toAbsoluteRedditUrl(string(data.permalink));
  const candidateSourceUrl =
    string(data.url_overridden_by_dest) ?? string(data.url);
  const sourceUrl =
    candidateSourceUrl &&
    new URL(candidateSourceUrl, REDDIT_ORIGIN).origin !== REDDIT_ORIGIN
      ? candidateSourceUrl
      : null;
  const deleted = isDeletedPost(data);

  return {
    id: externalId,
    source: "reddit",
    externalId,
    title: string(data.title),
    author: string(data.author),
    redditUrl,
    sourceUrl,
    score: number(data.score),
    upvoteRatio:
      typeof data.upvote_ratio === "number" && Number.isFinite(data.upvote_ratio)
        ? data.upvote_ratio
        : null,
    commentCount: number(data.num_comments),
    publishedAt: isoFromEpoch(data.created_utc),
    fetchedAt,
    lastCheckedAt: fetchedAt,
    deletedAt: deleted ? fetchedAt : null,
    stickied: data.stickied === true,
    over18: data.over_18 === true,
    deleted,
  };
}

export function parsePostListing(
  value: unknown,
  fetchedAt = new Date(),
): SourceItem[] {
  const fetchedAtIso = fetchedAt.toISOString();
  return childrenFromListing(value).flatMap((child) => {
    const item = postFromChild(child, fetchedAtIso);
    return item ? [item] : [];
  });
}

function flattenCommentChildren(
  children: unknown[],
  itemId: string,
  fetchedAt: string,
  result: SourceComment[],
): void {
  for (const childValue of children) {
    const child = record(childValue, "comment child");
    if (child.kind !== "t1") continue;
    const data = record(child.data, "comment data");
    const externalId = string(data.name);
    if (!externalId?.startsWith("t1_")) {
      throw new TypeError("Reddit comment is missing its fullname");
    }
    const body = string(data.body) ?? "";
    const deleted = body === "[deleted]" || data.author === null;

    result.push({
      id: externalId,
      itemId,
      externalId,
      parentExternalId: string(data.parent_id),
      author: string(data.author),
      body,
      score: number(data.score),
      depth: number(data.depth),
      redditUrl: toAbsoluteRedditUrl(string(data.permalink)),
      publishedAt:
        typeof data.created_utc === "number"
          ? isoFromEpoch(data.created_utc)
          : null,
      fetchedAt,
      deletedAt: deleted ? fetchedAt : null,
      deleted,
    });

    if (isRecord(data.replies)) {
      flattenCommentChildren(
        childrenFromListing(data.replies),
        itemId,
        fetchedAt,
        result,
      );
    }
  }
}

export function parseCommentListing(
  value: unknown,
  fetchedAt = new Date(),
): SourceComment[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new TypeError("Invalid Reddit post and comments response");
  }
  const posts = parsePostListing(value[0], fetchedAt);
  const item = posts[0];
  if (!item) {
    throw new TypeError("Reddit comments response is missing its post");
  }

  const result: SourceComment[] = [];
  flattenCommentChildren(
    childrenFromListing(value[1]),
    item.externalId,
    fetchedAt.toISOString(),
    result,
  );
  return result;
}
