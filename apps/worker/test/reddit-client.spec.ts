import commentsFixture from "./fixtures/reddit-comments.json";
import topFixture from "./fixtures/reddit-top.json";
import { describe, expect, it, vi } from "vitest";
import {
  AnonymousJsonRedditAdapter,
  RedditAccessDenied,
  RedditRateLimited,
  RedditTemporaryFailure,
  RedditUnexpectedResponse,
} from "../src/reddit/anonymous-json";

const userAgent = "web:everyday-news:v1.0 (by /u/test_owner)";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

describe("AnonymousJsonRedditAdapter", () => {
  it("uses the fixed todayilearned URL and configured headers", async () => {
    const fetcher = vi.fn(async () => jsonResponse(topFixture));
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    const posts = await adapter.listTopPosts({ limit: 20, time: "day" });

    expect(posts).toHaveLength(4);
    const request = fetcher.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(
      "https://www.reddit.com/r/todayilearned/top.json?t=day&limit=20&raw_json=1",
    );
    expect(request.headers.get("User-Agent")).toBe(userAgent);
    expect(request.headers.get("Accept")).toBe("application/json");
  });

  it("loads a post and its flattened comments", async () => {
    const fetcher = vi.fn(async () => jsonResponse(commentsFixture));
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    const result = await adapter.getPostWithComments("valid", { limit: 20, depth: 2 });

    expect(result.item.externalId).toBe("t3_valid");
    expect(result.comments).toHaveLength(3);
    const request = fetcher.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(
      "https://www.reddit.com/r/todayilearned/comments/valid.json?limit=20&depth=2&raw_json=1",
    );
  });

  it("checks item deletion through the by-id JSON endpoint", async () => {
    const fetcher = vi.fn(async () => jsonResponse(topFixture));
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    await expect(adapter.checkItems(["valid", "missing"])).resolves.toEqual([
      { id: "valid", deleted: false },
      { id: "missing", deleted: true },
    ]);
    const request = fetcher.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(
      "https://www.reddit.com/by_id/t3_valid,t3_missing.json?raw_json=1",
    );
  });

  it.each([401, 403])("maps %i to access denied without retry", async (status) => {
    const fetcher = vi.fn(async () => new Response("", { status }));
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    await expect(adapter.listTopPosts({ limit: 20, time: "day" })).rejects.toBeInstanceOf(
      RedditAccessDenied,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries 429 once using Retry-After and exposes it after the second response", async () => {
    const fetcher = vi.fn(async () =>
      new Response("", { status: 429, headers: { "Retry-After": "0" } }),
    );
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    await expect(adapter.listTopPosts({ limit: 20, time: "day" })).rejects.toMatchObject({
      constructor: RedditRateLimited,
      retryAfterSeconds: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("maps server errors to temporary failures", async () => {
    const adapter = new AnonymousJsonRedditAdapter({
      fetcher: vi.fn(async () => new Response("", { status: 500 })),
      userAgent,
    });

    await expect(adapter.listTopPosts({ limit: 20, time: "day" })).rejects.toBeInstanceOf(
      RedditTemporaryFailure,
    );
  });

  it.each([
    ["HTML challenge", new Response("<html>challenge</html>", { headers: { "Content-Type": "text/html" } })],
    ["invalid JSON", new Response("{nope", { headers: { "Content-Type": "application/json" } })],
  ])("rejects %s responses", async (_label, response) => {
    const adapter = new AnonymousJsonRedditAdapter({
      fetcher: vi.fn(async () => response),
      userAgent,
    });

    await expect(adapter.listTopPosts({ limit: 20, time: "day" })).rejects.toBeInstanceOf(
      RedditUnexpectedResponse,
    );
  });

  it("maps structurally invalid JSON to an unexpected response", async () => {
    const adapter = new AnonymousJsonRedditAdapter({
      fetcher: vi.fn(async () => jsonResponse({ not: "a listing" })),
      userAgent,
    });

    await expect(adapter.listTopPosts({ limit: 20, time: "day" })).rejects.toBeInstanceOf(
      RedditUnexpectedResponse,
    );
  });

  it("requires a descriptive configured user agent", () => {
    expect(
      () => new AnonymousJsonRedditAdapter({ fetcher: vi.fn(), userAgent: " " }),
    ).toThrow();
  });
});
