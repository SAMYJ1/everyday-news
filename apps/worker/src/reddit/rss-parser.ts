import { XMLParser } from "fast-xml-parser";
import type { SourceComment, SourceItem } from "../domain";

type XmlRecord = Record<string, unknown>;

const REDDIT_ORIGIN = "https://www.reddit.com";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
});

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, context: string): XmlRecord {
  if (!isRecord(value)) {
    throw new TypeError(`Invalid Reddit Atom ${context}`);
  }
  return value;
}

function rawText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value["#text"] === "string") {
    return value["#text"];
  }
  return null;
}

function decodeEntitiesOnce(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : hex
          ? Number.parseInt(hex, 16)
          : null;
      if (codePoint !== null) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return name ? (named[name.toLowerCase()] ?? match) : match;
    },
  );
}

function decodeEntities(value: string): string {
  return decodeEntitiesOnce(decodeEntitiesOnce(value));
}

function text(value: unknown): string | null {
  const raw = rawText(value);
  return raw === null ? null : decodeEntities(raw).trim();
}

function entriesFromAtom(value: unknown): XmlRecord[] {
  const document = record(value, "document");
  const feed = record(document.feed, "feed");
  const entries = Array.isArray(feed.entry)
    ? feed.entry
    : feed.entry === undefined
      ? []
      : [feed.entry];
  return entries.map((entry) => record(entry, "entry"));
}

function parseAtom(xml: string): XmlRecord[] {
  try {
    return entriesFromAtom(parser.parse(xml));
  } catch (error) {
    throw new TypeError("Invalid Reddit Atom feed", { cause: error });
  }
}

function entryId(entry: XmlRecord, kind: "t1" | "t3"): string {
  const id = text(entry.id);
  if (!id || !new RegExp(`^${kind}_[a-z0-9]+$`, "i").test(id)) {
    throw new TypeError(`Reddit Atom entry is missing its ${kind} fullname`);
  }
  return id;
}

function entryHref(entry: XmlRecord): string {
  const links = Array.isArray(entry.link) ? entry.link : [entry.link];
  for (const link of links) {
    if (!isRecord(link) || typeof link["@_href"] !== "string") continue;
    const url = new URL(decodeEntities(link["@_href"]), REDDIT_ORIGIN);
    if (
      url.protocol === "https:" &&
      (url.hostname === "reddit.com" || url.hostname.endsWith(".reddit.com"))
    ) {
      return url.toString();
    }
  }
  throw new TypeError("Reddit Atom entry is missing its Reddit link");
}

function entryDate(entry: XmlRecord): string {
  const value = text(entry.published) ?? text(entry.updated);
  const timestamp = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Reddit Atom entry is missing a valid publication time");
  }
  return new Date(timestamp).toISOString();
}

function entryAuthor(entry: XmlRecord): string | null {
  if (!isRecord(entry.author)) return null;
  const name = text(entry.author.name)?.replace(/^\/u\//i, "").trim() ?? null;
  return !name || name === "[deleted]" ? null : name;
}

function entryHtml(entry: XmlRecord): string {
  return decodeEntities(rawText(entry.content) ?? "");
}

function isRedditOwnedHost(hostname: string): boolean {
  return [
    "reddit.com",
    "redd.it",
    "redditmedia.com",
    "redditstatic.com",
  ].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function outboundUrl(html: string): string | null {
  const expression = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(expression)) {
    const href = decodeEntities(match[1] ?? match[2] ?? "");
    try {
      const url = new URL(href);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !isRedditOwnedHost(url.hostname.toLowerCase())
      ) {
        return url.toString();
      }
    } catch {
      // Ignore malformed links embedded in the feed.
    }
  }
  return null;
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(?:blockquote|div|li|ol|p|pre|ul)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function postFromEntry(
  entry: XmlRecord,
  fetchedAt: string,
  sourceRank: number,
  commentCount = 0,
): SourceItem {
  const externalId = entryId(entry, "t3");
  const title = text(entry.title);
  if (!title) {
    throw new TypeError("Reddit Atom post is missing its title");
  }
  return {
    id: externalId,
    source: "reddit",
    externalId,
    title,
    author: entryAuthor(entry),
    redditUrl: entryHref(entry),
    sourceUrl: outboundUrl(entryHtml(entry)),
    score: 0,
    upvoteRatio: null,
    commentCount,
    publishedAt: entryDate(entry),
    fetchedAt,
    lastCheckedAt: fetchedAt,
    deletedAt: null,
    stickied: false,
    over18: false,
    deleted: false,
    sourceRank,
  };
}

export function parseAtomPosts(
  xml: string,
  fetchedAt = new Date(),
): SourceItem[] {
  const fetchedAtIso = fetchedAt.toISOString();
  return parseAtom(xml).flatMap((entry, index) => {
    const id = text(entry.id);
    return id?.startsWith("t3_")
      ? [postFromEntry(entry, fetchedAtIso, index + 1)]
      : [];
  });
}

export function parseAtomThread(
  xml: string,
  fetchedAt = new Date(),
): { item: SourceItem; comments: SourceComment[] } {
  const entries = parseAtom(xml);
  const postEntry = entries.find((entry) => text(entry.id)?.startsWith("t3_"));
  if (!postEntry) {
    throw new TypeError("Reddit Atom thread is missing its post");
  }

  const fetchedAtIso = fetchedAt.toISOString();
  const commentEntries = entries.filter((entry) =>
    text(entry.id)?.startsWith("t1_")
  );
  const itemId = entryId(postEntry, "t3");
  const comments = commentEntries.map((entry, index): SourceComment => {
    const externalId = entryId(entry, "t1");
    const body = htmlToText(entryHtml(entry));
    const author = entryAuthor(entry);
    const deleted = author === null || body === "[deleted]" || body === "[removed]";
    return {
      id: externalId,
      itemId,
      externalId,
      parentExternalId: null,
      author,
      body,
      score: 0,
      depth: 0,
      redditUrl: entryHref(entry),
      publishedAt: entryDate(entry),
      fetchedAt: fetchedAtIso,
      deletedAt: deleted ? fetchedAtIso : null,
      deleted,
      sourceRank: index + 1,
    };
  });

  return {
    item: postFromEntry(postEntry, fetchedAtIso, 1, comments.length),
    comments,
  };
}
