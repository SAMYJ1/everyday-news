import type { SourceItem } from "../domain";

export interface RankingContext {
  now: Date;
  recentUrls: Set<string>;
  recentTitles: string[];
}

export interface Evaluation {
  eligible: boolean;
  score: number;
  reasons: string[];
  exclusion?: string;
}

function formatScore(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function normalizeSourceUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl.trim());
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return sourceUrl.trim();
  }
}

function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccardSimilarity(first: Set<string>, second: Set<string>): number {
  if (first.size === 0 || second.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of first) {
    if (second.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (first.size + second.size - intersection);
}

function exclude(exclusion: string): Evaluation {
  return { eligible: false, score: 0, reasons: [], exclusion };
}

export function evaluatePost(item: SourceItem, context: RankingContext): Evaluation {
  if (item.stickied) {
    return exclude("sticky");
  }
  if (item.over18) {
    return exclude("nsfw");
  }
  if (item.deleted) {
    return exclude("deleted");
  }
  if (item.title === null || item.title.trim() === "") {
    return exclude("no_title");
  }
  if (item.sourceUrl === null || item.sourceUrl.trim() === "") {
    return exclude("no_external_source");
  }

  const normalizedSourceUrl = normalizeSourceUrl(item.sourceUrl);
  const recentUrls = new Set([...context.recentUrls].map(normalizeSourceUrl));
  if (recentUrls.has(normalizedSourceUrl)) {
    return exclude("duplicate_url");
  }

  const itemTokens = titleTokens(item.title ?? "");
  if (context.recentTitles.some((title) => jaccardSimilarity(itemTokens, titleTokens(title)) >= 0.85)) {
    return exclude("similar_title");
  }

  const ageHours = (context.now.getTime() - new Date(item.publishedAt).getTime()) / (60 * 60 * 1000);
  const engagement = Math.min(40, Math.log10(Math.max(1, item.score)) * 10);
  const discussion = Math.min(30, Math.log10(Math.max(1, item.commentCount)) * 10);
  const freshness = Math.max(0, 20 - ageHours);
  const ratio = item.upvoteRatio == null ? 0 : Math.max(0, (item.upvoteRatio - 0.5) * 20);
  const score = Math.round((engagement + discussion + freshness + ratio) * 100) / 100;

  return {
    eligible: true,
    score,
    reasons: [
      `engagement: ${formatScore(engagement)}`,
      `discussion: ${formatScore(discussion)}`,
      `freshness: ${formatScore(freshness)}`,
      `ratio: ${formatScore(ratio)}`
    ]
  };
}
