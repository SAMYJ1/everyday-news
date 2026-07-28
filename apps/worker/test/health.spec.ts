import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("returns a versioned health response", async () => {
  const response = await exports.default.fetch("https://example.test/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "everyday-news-api", version: 1 });
});
