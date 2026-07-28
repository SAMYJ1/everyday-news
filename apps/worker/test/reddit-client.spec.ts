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

function listing(children: unknown[], after: string | null = null) {
  return { kind: "Listing", data: { children, after } };
}

function postChild(fullname: string) {
  const template = structuredClone(topFixture.data.children[0]);
  template.data.name = fullname;
  template.data.id = fullname.slice(3);
  template.data.permalink = `/r/todayilearned/comments/${fullname.slice(3)}/title/`;
  return template;
}

function commentChild(fullname: string) {
  return {
    kind: "t1",
    data: {
      name: fullname,
      author: "commenter",
      body: "A comment that still exists.",
    },
  };
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
      "https://www.reddit.com/r/todayilearned/comments/valid.json?sort=top&limit=20&depth=2&raw_json=1",
    );
  });

  it("checks item deletion through the by-id JSON endpoint", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(listing([postChild("t3_valid")])),
    );
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    await expect(adapter.checkItems(["valid", "missing"])).resolves.toEqual([
      { id: "valid", deleted: false },
      { id: "missing", deleted: true },
    ]);
    const request = fetcher.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(
      "https://www.reddit.com/by_id/t3_valid,t3_missing.json?limit=2&raw_json=1",
    );
  });

  it("bounds by-id lookups, sets each listing limit, and maps every chunk independently", async () => {
    const requested = [
      ...Array.from({ length: 26 }, (_, index) => `t3_post${index + 1}`),
      "t3_missing",
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      const names = url.pathname
        .replace(/^\/by_id\//, "")
        .replace(/\.json$/, "")
        .split(",");
      return jsonResponse(
        listing(
          names
            .filter((name) => name !== "t3_missing")
            .map(postChild),
        ),
      );
    });
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    const result = await adapter.checkItems(requested);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const requests = fetcher.mock.calls.map(([input]) => new URL((input as Request).url));
    expect(
      requests.map((url) => ({
        count: url.pathname
          .replace(/^\/by_id\//, "")
          .replace(/\.json$/, "")
          .split(",").length,
        limit: url.searchParams.get("limit"),
      })),
    ).toEqual([
      { count: 25, limit: "25" },
      { count: 2, limit: "2" },
    ]);
    expect(result).toHaveLength(27);
    expect(result.slice(0, 26)).toEqual(
      requested.slice(0, 26).map((id) => ({ id, deleted: false })),
    );
    expect(result[26]).toEqual({ id: "t3_missing", deleted: true });
  });

  it("rejects a paginated by-id response instead of treating omitted live posts as deleted", async () => {
    const adapter = new AnonymousJsonRedditAdapter({
      fetcher: vi.fn(async () =>
        jsonResponse(listing([postChild("t3_first")], "t3_omitted")),
      ),
      userAgent,
    });

    await expect(
      adapter.checkItems(["t3_first", "t3_omitted"]),
    ).rejects.toBeInstanceOf(RedditUnexpectedResponse);
  });

  it("rejects a by-id response containing a foreign fullname", async () => {
    const adapter = new AnonymousJsonRedditAdapter({
      fetcher: vi.fn(async () =>
        jsonResponse(listing([postChild("t3_not_requested")])),
      ),
      userAgent,
    });

    await expect(
      adapter.checkItems(["t3_requested"]),
    ).rejects.toBeInstanceOf(RedditUnexpectedResponse);
  });

  it("rejects oversized fullnames before constructing a lookup URL", async () => {
    const fetcher = vi.fn();
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    await expect(
      adapter.checkItems([`t3_${"a".repeat(33)}`]),
    ).rejects.toThrow("Invalid Reddit post id");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks stored comment fullnames through bounded complete info listings", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(listing([commentChild("t1_live")])),
    );
    const adapter = new AnonymousJsonRedditAdapter({ fetcher, userAgent });

    await expect(
      adapter.checkComments(["t1_live", "t1_deleted"]),
    ).resolves.toEqual([
      { id: "t1_live", deleted: false },
      { id: "t1_deleted", deleted: true },
    ]);
    const request = fetcher.mock.calls[0]?.[0] as Request;
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/info.json");
    expect(url.searchParams.get("id")).toBe("t1_live,t1_deleted");
    expect(url.searchParams.get("limit")).toBe("2");
  });

  it("rejects an incomplete comment info listing instead of deleting omitted comments", async () => {
    const adapter = new AnonymousJsonRedditAdapter({
      fetcher: vi.fn(async () =>
        jsonResponse(listing([commentChild("t1_live")], "t1_omitted")),
      ),
      userAgent,
    });

    await expect(
      adapter.checkComments(["t1_live", "t1_omitted"]),
    ).rejects.toBeInstanceOf(RedditUnexpectedResponse);
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
