import type { RedditSourceAdapter } from "./adapter";
import { parseCommentListing, parsePostListing } from "./parser";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class RedditAccessDenied extends Error {
  constructor(public readonly status: 401 | 403) {
    super(`Reddit access denied (${status})`);
    this.name = "RedditAccessDenied";
  }
}

export class RedditRateLimited extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Reddit rate limited (retry after ${retryAfterSeconds}s)`);
    this.name = "RedditRateLimited";
  }
}

export class RedditUnexpectedResponse extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedditUnexpectedResponse";
  }
}

export class RedditTemporaryFailure extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RedditTemporaryFailure";
  }
}

interface AnonymousJsonOptions {
  fetcher: Fetcher;
  userAgent: string;
}

const ORIGIN = "https://www.reddit.com";

function retryAfterSeconds(value: string | null): number {
  if (!value) return 1;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
  }
  return 1;
}

function wait(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
}

export class AnonymousJsonRedditAdapter implements RedditSourceAdapter {
  private readonly fetcher: Fetcher;
  private readonly userAgent: string;

  constructor({ fetcher, userAgent }: AnonymousJsonOptions) {
    if (!userAgent.trim()) {
      throw new TypeError("REDDIT_USER_AGENT must be configured");
    }
    this.fetcher = fetcher;
    this.userAgent = userAgent;
  }

  async listTopPosts(options: { limit: number; time: "day" }) {
    const url = this.url("/r/todayilearned/top.json", {
      t: options.time,
      limit: this.boundedInteger(options.limit, 1, 20, "limit"),
      raw_json: 1,
    });
    try {
      return parsePostListing(await this.requestJson(url));
    } catch (error) {
      this.rethrowTyped(error);
      throw new RedditUnexpectedResponse("Invalid Reddit top-post listing", {
        cause: error,
      });
    }
  }

  async getPostWithComments(
    postId: string,
    options: { limit: number; depth: number },
  ) {
    const bareId = this.barePostId(postId);
    const url = this.url(
      `/r/todayilearned/comments/${encodeURIComponent(bareId)}.json`,
      {
        sort: "top",
        limit: this.boundedInteger(options.limit, 1, 100, "limit"),
        depth: this.boundedInteger(options.depth, 0, 10, "depth"),
        raw_json: 1,
      },
    );
    const payload = await this.requestJson(url);
    if (!Array.isArray(payload)) {
      throw new RedditUnexpectedResponse(
        "Reddit post response was not a two-listing array",
      );
    }
    try {
      const item = parsePostListing(payload[0])[0];
      if (!item) {
        throw new TypeError("post listing was empty");
      }
      return { item, comments: parseCommentListing(payload) };
    } catch (error) {
      throw new RedditUnexpectedResponse("Invalid Reddit post response", {
        cause: error,
      });
    }
  }

  async checkItems(ids: string[]) {
    if (ids.length === 0) return [];
    const requested = ids.map((id) => ({
      id,
      fullname: `t3_${this.barePostId(id)}`,
    }));
    const url = this.url(
      "/by_id/" + requested.map(({ fullname }) => fullname).join(",") + ".json",
      { raw_json: 1 },
    );
    let items;
    try {
      items = parsePostListing(await this.requestJson(url));
    } catch (error) {
      this.rethrowTyped(error);
      throw new RedditUnexpectedResponse("Invalid Reddit item check response", {
        cause: error,
      });
    }
    const found = new Map(items.map((item) => [item.externalId, item]));
    return requested.map(({ id, fullname }) => ({
      id,
      deleted: found.get(fullname)?.deleted ?? true,
    }));
  }

  private async requestJson(url: URL): Promise<unknown> {
    let response = await this.fetch(url);
    if (response.status === 429) {
      const delay = retryAfterSeconds(response.headers.get("Retry-After"));
      await wait(delay);
      response = await this.fetch(url);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RedditAccessDenied(response.status);
    }
    if (response.status === 429) {
      throw new RedditRateLimited(
        retryAfterSeconds(response.headers.get("Retry-After")),
      );
    }
    if (response.status >= 500) {
      throw new RedditTemporaryFailure(
        `Reddit temporary failure (${response.status})`,
        response.status,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new RedditUnexpectedResponse(
        `Reddit attempted an unexpected redirect (${response.status})`,
      );
    }
    if (!response.ok) {
      throw new RedditUnexpectedResponse(
        `Unexpected Reddit HTTP status ${response.status}`,
      );
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!/(?:^|;)\s*application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
      throw new RedditUnexpectedResponse(
        `Unexpected Reddit content type: ${contentType || "(missing)"}`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new RedditUnexpectedResponse("Reddit returned invalid JSON", {
        cause: error,
      });
    }
  }

  private async fetch(url: URL): Promise<Response> {
    if (url.origin !== ORIGIN) {
      throw new TypeError("Anonymous Reddit adapter only permits www.reddit.com");
    }
    try {
      return await this.fetcher(
        new Request(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          redirect: "manual",
        }),
      );
    } catch (error) {
      throw new RedditTemporaryFailure("Reddit request failed", undefined, {
        cause: error,
      });
    }
  }

  private url(path: string, query: Record<string, string | number>): URL {
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    return url;
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

  private barePostId(value: string): string {
    const bare = value.startsWith("t3_") ? value.slice(3) : value;
    if (!/^[A-Za-z0-9]+$/.test(bare)) {
      throw new TypeError("Invalid Reddit post id");
    }
    return bare;
  }

  private rethrowTyped(error: unknown): void {
    if (
      error instanceof RedditAccessDenied ||
      error instanceof RedditRateLimited ||
      error instanceof RedditTemporaryFailure ||
      error instanceof RedditUnexpectedResponse
    ) {
      throw error;
    }
  }
}
