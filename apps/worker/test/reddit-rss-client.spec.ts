import hotFixture from "./fixtures/reddit-hot.atom?raw";
import { describe, expect, it, vi } from "vitest";
import {
  RedditAccessDenied,
  RedditChallenge,
  RedditRateLimited,
  RedditUnexpectedResponse,
} from "../src/reddit/anonymous-json";
import { RssRedditAdapter } from "../src/reddit/rss";

const userAgent =
  "Mozilla/5.0 (compatible; EverydayNews/0.1; +https://github.com/SAMYJ1/everyday-news)";

function atomResponse(body = hotFixture, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: {
      "Content-Type": "application/atom+xml; charset=UTF-8",
      ...init?.headers,
    },
  });
}

describe("RssRedditAdapter", () => {
  it("requests the fixed hot feed with configured RSS headers", async () => {
    const fetcher = vi.fn(async () => atomResponse());
    const adapter = new RssRedditAdapter({ fetcher, userAgent });

    const posts = await adapter.listTopPosts({ limit: 1, time: "day" });

    expect(posts).toHaveLength(1);
    const request = fetcher.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(
      "https://www.reddit.com/r/todayilearned/hot.rss",
    );
    expect(request.headers.get("User-Agent")).toBe(userAgent);
    expect(request.headers.get("Accept")).toContain("application/atom+xml");
    expect(request.redirect).toBe("manual");
  });

  it("requests a post comment feed and validates the post id", async () => {
    const fetcher = vi.fn(async () => atomResponse());
    const adapter = new RssRedditAdapter({ fetcher, userAgent });

    await adapter.getPostWithComments("t3_abc123", { limit: 100, depth: 2 });

    expect((fetcher.mock.calls[0]?.[0] as Request).url).toBe(
      "https://www.reddit.com/r/todayilearned/comments/abc123/.rss",
    );
    await expect(
      adapter.getPostWithComments("../bad", { limit: 100, depth: 2 }),
    ).rejects.toThrow("Invalid Reddit post id");
  });

  it("does not retry a 429 response and uses Reddit's reset header", async () => {
    const fetcher = vi.fn(async () =>
      new Response("", {
        status: 429,
        headers: { "X-Ratelimit-Reset": "47" },
      })
    );
    const adapter = new RssRedditAdapter({ fetcher, userAgent });

    await expect(
      adapter.listTopPosts({ limit: 20, time: "day" }),
    ).rejects.toMatchObject({
      constructor: RedditRateLimited,
      retryAfterSeconds: 47,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("maps %i to access denied", async (status) => {
    const adapter = new RssRedditAdapter({
      fetcher: vi.fn(async () => new Response("", { status })),
      userAgent,
    });
    await expect(
      adapter.listTopPosts({ limit: 20, time: "day" }),
    ).rejects.toBeInstanceOf(RedditAccessDenied);
  });

  it("rejects HTML and oversized Atom responses", async () => {
    const htmlAdapter = new RssRedditAdapter({
      fetcher: vi.fn(async () =>
        new Response("<html>challenge</html>", {
          headers: { "Content-Type": "text/html" },
        })
      ),
      userAgent,
    });
    await expect(
      htmlAdapter.listTopPosts({ limit: 20, time: "day" }),
    ).rejects.toBeInstanceOf(RedditChallenge);

    const oversizedAdapter = new RssRedditAdapter({
      fetcher: vi.fn(async () =>
        atomResponse("", { headers: { "Content-Length": "2097153" } })
      ),
      userAgent,
    });
    await expect(
      oversizedAdapter.listTopPosts({ limit: 20, time: "day" }),
    ).rejects.toBeInstanceOf(RedditUnexpectedResponse);
  });
});
