import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../api/client";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createApiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bearer key and parses the API error envelope", async () => {
    const fetchMock = vi.fn(async () => response({
      error: { code: "unauthorized", message: "Access denied" },
    }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = createApiClient("https://api.example.test/", () => "secret-key");

    await expect(client.getLatestRun()).rejects.toEqual(new ApiError(401, "unauthorized", "Access denied"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/runs/latest",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-key" }) }),
    );
  });

  it("uses JSON for write operations", async () => {
    const fetchMock = vi.fn(async () => response({ anonymousCollection: { enabled: true, consecutiveFailures: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    await createApiClient("https://api.example.test", () => "secret-key").setAnonymousCollection(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/settings/anonymous-collection",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ enabled: true }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });
});
