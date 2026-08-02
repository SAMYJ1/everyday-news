import { describe, expect, it, vi } from "vitest";
import { AnonymousJsonRedditAdapter } from "../src/reddit/anonymous-json";
import listing from "./fixtures/reddit-top.json?raw";

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

describe("Reddit OAuth adapter", () => {
  it("gets one client-credentials token and reuses it for authenticated API reads", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url.endsWith("/api/v1/access_token")) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("Authorization")).toMatch(/^Basic /);
        expect((await request.formData()).get("grant_type")).toBe("client_credentials");
        return jsonResponse(JSON.stringify({ access_token: "token-1", expires_in: 3600 }));
      }
      expect(request.url).toContain("https://oauth.reddit.com/r/todayilearned/top.json");
      expect(request.headers.get("Authorization")).toBe("Bearer token-1");
      return jsonResponse(listing);
    });
    const adapter = new AnonymousJsonRedditAdapter({
      fetcher,
      userAgent: "everyday-news-test",
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    await adapter.listTopPosts({ limit: 1, time: "day" });
    await adapter.listTopPosts({ limit: 1, time: "day" });

    expect(adapter.accessMode).toBe("oauth");
    expect(fetcher.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith("/api/v1/access_token"))).toHaveLength(1);
  });

  it("requires both OAuth secrets", () => {
    expect(() => new AnonymousJsonRedditAdapter({
      fetcher: fetch,
      userAgent: "everyday-news-test",
      clientId: "client-id",
    })).toThrow("must be configured together");
  });
});
