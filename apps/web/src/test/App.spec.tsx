// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

const draftCard = {
  id: "card-1",
  candidateId: "candidate-1",
  status: "draft",
  titleZh: "一只好奇的章鱼",
  oneLineFact: "原帖声称章鱼会使用工具。",
  whyInteresting: "它挑战了我们对无脊椎动物的想象。",
  commentInsights: ["评论补充了观察条件。"],
  caveats: ["这不是外部事实核查。"],
  confidenceNote: "仅根据原帖与有限评论整理。",
  model: "test-model",
  promptVersion: "v1",
  inputHash: "hash",
  generatedAt: "2026-07-24T00:00:00.000Z",
  reviewedAt: null,
  titleEn: "Octopuses use tools",
  redditUrl: "https://reddit.example.test/post",
  sourceUrl: "https://source.example.test/article",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installApiMock(runStatus: "running" | "partial" | "completed" = "partial") {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/runs/latest")) {
      return response({ run: {
        id: "run-1", localDate: "2026-07-24", status: runStatus,
        discoveredCount: 20, selectedCount: 5, summarizedCount: 3,
        errorCode: "reddit_rate_limited", errorMessage: "Collector paused", startedAt: "2026-07-24T00:00:00.000Z", finishedAt: null,
      } });
    }
    if (url.includes("/api/cards?status=draft")) return response({ cards: [draftCard] });
    if (url.endsWith("/api/cards/card-1")) return response({ card: draftCard });
    if (url.endsWith("/approve") && init?.method === "POST") {
      return response({ card: { ...draftCard, status: "approved" } });
    }
    if (url.endsWith("/regenerate") && init?.method === "POST") return response({ card: draftCard }, 202);
    if (url.endsWith("/api/runs") && init?.method === "POST") return response({ run: { id: "run-2" } }, 202);
    return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
  });
}

describe("App", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", installApiMock());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not request cards before an access key is entered", () => {
    render(<App apiBaseUrl="https://api.example.test" />);

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("管理员访问密钥")).toBeInTheDocument();
  });

  it("stores the access key in sessionStorage only", async () => {
    const localStorageSet = vi.spyOn(localStorage, "setItem");
    render(<App apiBaseUrl="https://api.example.test" />);

    fireEvent.change(screen.getByLabelText("管理员访问密钥"), { target: { value: "secret-key" } });
    fireEvent.click(screen.getByRole("button", { name: "进入审核台" }));

    await waitFor(() => expect(sessionStorage.getItem("everyday-news-admin-key")).toBe("secret-key"));
    expect(localStorageSet).not.toHaveBeenCalledWith("everyday-news-admin-key", "secret-key");
  });

  it("shows latest run counts and failures", async () => {
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    expect(await screen.findByRole("heading", { name: "今日草稿" })).toBeInTheDocument();
    const runStatus = screen.getByRole("region", { name: /2026-07-24/ });
    expect(within(runStatus).getByText("20")).toBeInTheDocument();
    expect(within(runStatus).getByText("5")).toBeInTheDocument();
    expect(within(runStatus).getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Collector paused")).toBeInTheDocument();
  });

  it("approves a draft and removes it from the draft list", async () => {
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    const approve = await screen.findByRole("button", { name: "批准 一只好奇的章鱼" });
    fireEvent.click(approve);

    await waitFor(() => expect(screen.queryByText("原帖声称章鱼会使用工具。")).not.toBeInTheDocument());
  });

  it("shows source links and confidence note in card detail", async () => {
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    fireEvent.click(await screen.findByRole("button", { name: "查看 一只好奇的章鱼" }));

    expect(await screen.findByRole("heading", { name: "一只好奇的章鱼" })).toBeInTheDocument();
    expect(screen.getByText("仅根据原帖与有限评论整理。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reddit 原帖" })).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.getByRole("link", { name: "外部来源" })).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("disables manual run while a run is active", async () => {
    vi.stubGlobal("fetch", installApiMock("running"));
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    expect(await screen.findByRole("button", { name: "手动运行" })).toBeDisabled();
  });
});
