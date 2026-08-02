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

export class RedditChallenge extends RedditUnexpectedResponse {
  constructor() {
    super("Reddit returned an HTML or non-JSON challenge response");
    this.name = "RedditChallenge";
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
  clientId?: string;
  clientSecret?: string;
}

const ORIGIN = "https://www.reddit.com";
const OAUTH_ORIGIN = "https://oauth.reddit.com";
// A Reddit Listing slice defaults to 25. Keep each lookup at that documented
// size and set the limit explicitly so omission remains a deletion signal.
const LOOKUP_CHUNK_SIZE = 25;
const MAX_BARE_FULLNAME_LENGTH = 32;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedListing(
  value: unknown,
  requested: Set<string>,
  kind: "t1" | "t3",
): Map<string, boolean> {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new TypeError("Invalid Reddit item-state listing");
  }
  const { data } = value;
  if (!Array.isArray(data.children)) {
    throw new TypeError("Invalid Reddit item-state listing children");
  }
  if (
    (data.after !== null && data.after !== undefined) ||
    (data.before !== null && data.before !== undefined)
  ) {
    throw new TypeError("Reddit item-state listing was paginated");
  }
  if (
    typeof data.dist === "number" &&
    Number.isFinite(data.dist) &&
    data.dist !== data.children.length
  ) {
    throw new TypeError("Reddit item-state listing was incomplete");
  }
  if (data.children.length > requested.size) {
    throw new TypeError("Reddit item-state listing exceeded its requested limit");
  }

  const found = new Map<string, boolean>();
  for (const value of data.children) {
    if (!isRecord(value) || value.kind !== kind || !isRecord(value.data)) {
      throw new TypeError("Reddit item-state listing contained an unexpected child");
    }
    const name = value.data.name;
    if (
      typeof name !== "string" ||
      !requested.has(name) ||
      found.has(name)
    ) {
      throw new TypeError("Reddit item-state listing contained an invalid fullname");
    }
    const deleted = kind === "t3"
      ? value.data.removed_by_category === "deleted" ||
        value.data.title === "[deleted]" ||
        value.data.selftext === "[deleted]"
      : value.data.author === null ||
        value.data.body === "[deleted]" ||
        value.data.body === "[removed]";
    found.set(name, deleted);
  }
  return found;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

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
  readonly accessMode: "rss" | "oauth";
  private readonly fetcher: Fetcher;
  private readonly userAgent: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly origin: string;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor({ fetcher, userAgent, clientId, clientSecret }: AnonymousJsonOptions) {
    if (!userAgent.trim()) {
      throw new TypeError("REDDIT_USER_AGENT must be configured");
    }
    if ((clientId === undefined) !== (clientSecret === undefined)) {
      throw new TypeError("REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET must be configured together");
    }
    this.fetcher = fetcher;
    this.userAgent = userAgent;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessMode = clientId === undefined ? "rss" : "oauth";
    this.origin = this.accessMode === "oauth" ? OAUTH_ORIGIN : ORIGIN;
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
    return this.checkFullnames(
      ids,
      "t3",
      (fullnames) => this.url(
        "/by_id/" + fullnames.join(",") + ".json",
        { limit: fullnames.length, raw_json: 1 },
      ),
    );
  }

  async checkComments(ids: string[]) {
    return this.checkFullnames(
      ids,
      "t1",
      (fullnames) => this.url("/api/info.json", {
        id: fullnames.join(","),
        limit: fullnames.length,
        raw_json: 1,
      }),
    );
  }

  private async requestJson(url: URL): Promise<unknown> {
    let response = await this.fetch(url);
    if (response.status === 401 && this.accessMode === "oauth") {
      this.accessToken = null;
      response = await this.fetch(url);
    }
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
      throw new RedditChallenge();
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
    if (url.origin !== this.origin) {
      throw new TypeError("Reddit adapter request origin did not match its configured access mode");
    }
    try {
      const authorization = await this.authorizationHeader();
      return await this.fetcher(
        new Request(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
            ...(authorization === null ? {} : { Authorization: authorization }),
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

  private async authorizationHeader(): Promise<string | null> {
    if (this.clientId === undefined || this.clientSecret === undefined) return null;
    if (this.accessToken !== null && this.accessToken.expiresAt > Date.now() + 60_000) {
      return `Bearer ${this.accessToken.value}`;
    }
    const response = await this.fetcher(new Request("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
      },
      body: "grant_type=client_credentials",
      redirect: "manual",
    }));
    if (response.status === 401 || response.status === 403) {
      throw new RedditAccessDenied(response.status);
    }
    if (response.status === 429) {
      throw new RedditRateLimited(retryAfterSeconds(response.headers.get("Retry-After")));
    }
    if (response.status >= 500) {
      throw new RedditTemporaryFailure(`Reddit OAuth token failure (${response.status})`, response.status);
    }
    if (!response.ok) {
      throw new RedditUnexpectedResponse(`Unexpected Reddit OAuth token status ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" || payload === null ||
      !("access_token" in payload) || typeof payload.access_token !== "string" ||
      !("expires_in" in payload) || typeof payload.expires_in !== "number"
    ) {
      throw new RedditUnexpectedResponse("Invalid Reddit OAuth token response");
    }
    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(0, payload.expires_in) * 1_000,
    };
    return `Bearer ${this.accessToken.value}`;
  }

  private url(path: string, query: Record<string, string | number>): URL {
    const url = new URL(path, this.origin);
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

  private async checkFullnames(
    ids: string[],
    kind: "t1" | "t3",
    urlFor: (fullnames: string[]) => URL,
  ): Promise<Array<{ id: string; deleted: boolean }>> {
    if (ids.length === 0) return [];
    const requested = ids.map((id) => ({
      id,
      fullname: this.fullname(id, kind),
    }));
    const result: Array<{ id: string; deleted: boolean }> = [];

    for (const chunk of chunks(requested, LOOKUP_CHUNK_SIZE)) {
      const fullnames = chunk.map(({ fullname }) => fullname);
      let found;
      try {
        found = checkedListing(
          await this.requestJson(urlFor(fullnames)),
          new Set(fullnames),
          kind,
        );
      } catch (error) {
        this.rethrowTyped(error);
        throw new RedditUnexpectedResponse(
          `Invalid Reddit ${kind === "t3" ? "item" : "comment"} check response`,
          { cause: error },
        );
      }
      for (const { id, fullname } of chunk) {
        result.push({ id, deleted: found.get(fullname) ?? true });
      }
    }
    return result;
  }

  private fullname(value: string, kind: "t1" | "t3"): string {
    const prefix = `${kind}_`;
    const bare = value.startsWith(prefix) ? value.slice(prefix.length) : value;
    if (
      bare.length > MAX_BARE_FULLNAME_LENGTH ||
      !/^[A-Za-z0-9]+$/.test(bare)
    ) {
      throw new TypeError(`Invalid Reddit ${kind === "t3" ? "post" : "comment"} id`);
    }
    return `${prefix}${bare}`;
  }

  private barePostId(value: string): string {
    return this.fullname(value, "t3").slice(3);
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
