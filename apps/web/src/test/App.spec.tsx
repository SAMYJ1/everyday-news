// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const run = {
  id: "run-1", localDate: "2026-08-01", status: "partial",
  discoveredCount: 20, selectedCount: 5, summarizedCount: 3, failedCount: 2,
  errorCode: "candidate_failures", errorMessage: "Two candidates failed",
  startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:10:00.000Z",
};

describe("operations App", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stores the access key in session storage and opens an operations-only dashboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run });
      if (url.endsWith("/api/runs")) return response({ runs: [run] });
      return response({}, 404);
    }));
    render(<App apiBaseUrl="https://api.example.test" />);
    fireEvent.change(screen.getByLabelText("管理员访问密钥"), { target: { value: "secret-key" } });
    fireEvent.click(screen.getByRole("button", { name: "进入运维页" }));

    expect(await screen.findByRole("heading", { name: "采集运行状态" })).toBeInTheDocument();
    expect(sessionStorage.getItem("everyday-news-admin-key")).toBe("secret-key");
    expect(screen.getByText("内容发布由 AI 自动筛选，本页不提供人工审核。")).toBeInTheDocument();
    expect(screen.queryByText("审核队列")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
  });

  it("starts one manual run and refreshes its status", async () => {
    sessionStorage.setItem("everyday-news-admin-key", "secret-key");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs") && init?.method === "POST") return response({ run: { id: "run-2" } }, 202);
      if (url.endsWith("/api/runs/latest")) return response({ run });
      if (url.endsWith("/api/runs")) return response({ runs: [run] });
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" />);

    fireEvent.click(await screen.findByRole("button", { name: "手动运行" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/runs",
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("clears an expired access key", async () => {
    sessionStorage.setItem("everyday-news-admin-key", "expired");
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: { code: "unauthorized", message: "Unauthorized" } }, 401)));
    render(<App apiBaseUrl="https://api.example.test" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("访问密钥无效");
    expect(sessionStorage.getItem("everyday-news-admin-key")).toBeNull();
  });
});
