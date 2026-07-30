import type { RedditSourceAdapter } from "./adapter";
import {
  RedditAccessDenied,
  RedditChallenge,
  RedditRateLimited,
  RedditTemporaryFailure,
  RedditUnexpectedResponse,
} from "./anonymous-json";
import { parseAtomPosts, parseAtomThread } from "./rss-parser";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface RssOptions {
  fetcher: Fetcher;
  userAgent: string;
}

const ORIGIN = "https://www.reddit.com";
const MAX_FEED_BYTES = 2 * 1024 * 1024;

function retryAfterSeconds(response: Response): number {
  const value = response.headers.get("Retry-After")
    ?? response.headers.get("X-Ratelimit-Reset");
  if (!value) return 60;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? 60
    : Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

async function readTextLimited(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FEED_BYTES) {
    throw new RedditUnexpectedResponse("Reddit Atom feed exceeded the size limit");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new RedditUnexpectedResponse("Reddit Atom feed exceeded the size limit");
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

export class RssRedditAdapter implements RedditSourceAdapter {
  readonly supportsStateChecks = false;
  private readonly fetcher: Fetcher;
  private readonly userAgent: string;

  constructor({ fetcher, userAgent }: RssOptions) {
    if (!userAgent.trim()) {
      throw new TypeError("REDDIT_USER_AGENT must be configured");
    }
    this.fetcher = fetcher;
    this.userAgent = userAgent;
  }

  async listTopPosts(options: { limit: number; time: "day" }) {
    const limit = this.boundedInteger(options.limit, 1, 25, "limit");
    const xml = await this.requestAtom(new URL("/r/todayilearned/hot.rss", ORIGIN));
    try {
      return parseAtomPosts(xml).slice(0, limit);
    } catch (error) {
      throw new RedditUnexpectedResponse("Invalid Reddit hot Atom feed", {
        cause: error,
      });
    }
  }

  async getPostWithComments(
    postId: string,
    options: { limit: number; depth: number },
  ) {
    const bareId = this.barePostId(postId);
    const limit = this.boundedInteger(options.limit, 1, 200, "limit");
    this.boundedInteger(options.depth, 0, 10, "depth");
    const xml = await this.requestAtom(
      new URL(
        `/r/todayilearned/comments/${encodeURIComponent(bareId)}/.rss`,
        ORIGIN,
      ),
    );
    try {
      const result = parseAtomThread(xml);
      return { ...result, comments: result.comments.slice(0, limit) };
    } catch (error) {
      throw new RedditUnexpectedResponse("Invalid Reddit comments Atom feed", {
        cause: error,
      });
    }
  }

  async checkItems(ids: string[]) {
    return ids.map((id) => ({ id, deleted: false }));
  }

  async checkComments(ids: string[]) {
    return ids.map((id) => ({ id, deleted: false }));
  }

  private async requestAtom(url: URL): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(
        new Request(url, {
          headers: {
            Accept: "application/atom+xml, application/rss+xml;q=0.9",
            "User-Agent": this.userAgent,
          },
          redirect: "manual",
        }),
      );
    } catch (error) {
      throw new RedditTemporaryFailure("Reddit RSS request failed", undefined, {
        cause: error,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new RedditAccessDenied(response.status);
    }
    if (response.status === 429) {
      throw new RedditRateLimited(retryAfterSeconds(response));
    }
    if (response.status >= 500) {
      throw new RedditTemporaryFailure(
        `Reddit RSS temporary failure (${response.status})`,
        response.status,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new RedditUnexpectedResponse(
        `Reddit RSS attempted an unexpected redirect (${response.status})`,
      );
    }
    if (!response.ok) {
      throw new RedditUnexpectedResponse(
        `Unexpected Reddit RSS HTTP status ${response.status}`,
      );
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!/(?:application|text)\/(?:atom\+xml|rss\+xml|xml)(?:\s*;|$)/i.test(contentType)) {
      throw new RedditChallenge();
    }
    return readTextLimited(response);
  }

  private barePostId(value: string): string {
    const bare = value.startsWith("t3_") ? value.slice(3) : value;
    if (bare.length > 32 || !/^[A-Za-z0-9]+$/.test(bare)) {
      throw new TypeError("Invalid Reddit post id");
    }
    return bare;
  }

  private boundedInteger(
    value: number,
    minimum: number,
    maximum: number,
    name: string,
  ): number {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
  }
}
