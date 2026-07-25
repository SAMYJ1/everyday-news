// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  candidateScore: 87.5,
  selectionReasons: ["讨论热度高", "来源新鲜"],
  commentLinks: [
    "https://reddit.example.test/comment/high-score",
    "https://reddit.example.test/comment/context",
  ],
  warnings: [{
    code: "reddit_rate_limited",
    message: "评论采集受限，摘要使用了已保留的评论。",
  }],
  runLocalDate: "2026-07-24",
};

function card(overrides: Partial<typeof draftCard> = {}) {
  return { ...draftCard, ...overrides };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installApiMock(runStatus: "running" | "partial" | "completed" = "partial") {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/runs/latest")) {
      return response({ run: {
        id: "run-1", localDate: "2026-07-24", status: runStatus,
        discoveredCount: 20, selectedCount: 5, summarizedCount: 3, failedCount: 2,
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
    vi.useRealTimers();
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

  it("shows failed count, candidate score, and selection reasons", async () => {
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    const runStatus = await screen.findByRole("region", { name: /2026-07-24/ });
    expect(within(runStatus).getByText("2")).toBeInTheDocument();
    const draft = screen.getByRole("article");
    expect(within(draft).getByText("候选分：87.5")).toBeInTheDocument();
    expect(within(draft).getByText("讨论热度高")).toBeInTheDocument();
    expect(within(draft).getByText("来源新鲜")).toBeInTheDocument();
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

  it("shows participating comment links and run warnings in detail", async () => {
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    fireEvent.click(await screen.findByRole("button", { name: "查看 一只好奇的章鱼" }));

    const detail = await screen.findByRole("region", { name: "一只好奇的章鱼" });
    expect(within(detail).getByText("评论采集受限，摘要使用了已保留的评论。")).toBeInTheDocument();
    const commentLinks = within(detail).getAllByRole("link", { name: /参与评论/ });
    expect(commentLinks.map((link) => link.getAttribute("href"))).toEqual([
      "https://reddit.example.test/comment/high-score",
      "https://reddit.example.test/comment/context",
    ]);
    for (const link of commentLinks) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });

  it("loads today drafts using the latest run local date", async () => {
    let resolveLatest!: (value: Response) => void;
    const latest = new Promise<Response>((resolve) => { resolveLatest = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return latest;
      if (url === "https://api.example.test/api/cards?status=draft&date=2026-07-24") {
        return response({ cards: [draftCard] });
      }
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveLatest(response({ run: {
      id: "run-1",
      localDate: "2026-07-24",
      status: "completed",
      discoveredCount: 1,
      selectedCount: 1,
      summarizedCount: 1,
      failedCount: 0,
      errorCode: null,
      errorMessage: null,
      startedAt: "2026-07-24T00:00:00.000Z",
      finishedAt: "2026-07-24T00:01:00.000Z",
    } }));

    expect(await screen.findByText(draftCard.titleZh)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/api/cards?status=draft&date=2026-07-24",
      expect.anything(),
    );
  });

  it("filters approved and rejected history by the selected date", async () => {
    const approved = card({
      id: "approved-card",
      status: "approved",
      titleZh: "指定日期批准的卡片",
      runLocalDate: "2026-07-20",
    });
    const rejected = card({
      id: "rejected-card",
      status: "rejected",
      titleZh: "指定日期淘汰的卡片",
      runLocalDate: "2026-07-20",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run: {
        id: "run-1",
        localDate: "2026-07-24",
        status: "completed",
        discoveredCount: 1,
        selectedCount: 1,
        summarizedCount: 1,
        failedCount: 0,
        errorCode: null,
        errorMessage: null,
        startedAt: "2026-07-24T00:00:00.000Z",
        finishedAt: "2026-07-24T00:01:00.000Z",
      } });
      if (url.includes("status=draft")) return response({ cards: [draftCard] });
      if (url === "https://api.example.test/api/cards?status=approved&date=2026-07-20") {
        return response({ cards: [approved] });
      }
      if (url === "https://api.example.test/api/cards?status=rejected&date=2026-07-20") {
        return response({ cards: [rejected] });
      }
      if (url.includes("status=approved") || url.includes("status=rejected")) {
        return response({ cards: [] });
      }
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    fireEvent.click(await screen.findByRole("button", { name: "已批准" }));
    const date = screen.getByLabelText("历史日期");
    expect(date).toHaveAttribute("type", "date");
    fireEvent.change(date, { target: { value: "2026-07-20" } });
    expect(await screen.findByText("指定日期批准的卡片")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "已淘汰" }));
    expect(await screen.findByText("指定日期淘汰的卡片")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/cards?status=rejected&date=2026-07-20",
      expect.anything(),
    );
  });

  it("disables manual run while a run is active", async () => {
    vi.stubGlobal("fetch", installApiMock("running"));
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    expect(await screen.findByRole("button", { name: "手动运行" })).toBeDisabled();
  });

  it("clears a rejected access key and returns to the gate with an error", async () => {
    sessionStorage.setItem("everyday-news-admin-key", "expired-key");
    vi.stubGlobal("fetch", vi.fn(async () => response({
      error: { code: "unauthorized", message: "Unauthorized" },
    }, 401)));

    render(<App apiBaseUrl="https://api.example.test" />);

    expect(await screen.findByLabelText("管理员访问密钥")).toHaveAttribute("type", "password");
    expect(screen.getByRole("alert")).toHaveTextContent("访问密钥无效");
    expect(sessionStorage.getItem("everyday-news-admin-key")).toBeNull();
  });

  it("ignores a stale tab response after the selected status changes", async () => {
    let resolveDraft!: (value: Response) => void;
    const draftResponse = new Promise<Response>((resolve) => { resolveDraft = resolve; });
    const approvedCard = card({ id: "card-2", status: "approved", titleZh: "已批准的知识" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run: null });
      if (url.includes("status=draft")) return draftResponse;
      if (url.includes("status=approved")) return response({ cards: [approvedCard] });
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("status=draft"),
      expect.anything(),
    ));
    fireEvent.click(screen.getByRole("button", { name: "已批准" }));
    expect(await screen.findByText("已批准的知识")).toBeInTheDocument();

    resolveDraft(response({ cards: [draftCard] }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(draftCard.titleZh)).not.toBeInTheDocument();
    expect(screen.getByText("已批准的知识")).toBeInTheDocument();
  });

  it("ignores stale card details and focuses the latest opened detail", async () => {
    const secondCard = card({ id: "card-2", titleZh: "第二张卡片" });
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const firstDetail = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondDetail = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run: null });
      if (url.includes("/api/cards?status=draft")) return response({ cards: [draftCard, secondCard] });
      if (url.endsWith("/api/cards/card-1")) return firstDetail;
      if (url.endsWith("/api/cards/card-2")) return secondDetail;
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    fireEvent.click(await screen.findByRole("button", { name: `查看 ${draftCard.titleZh}` }));
    fireEvent.click(screen.getByRole("button", { name: "查看 第二张卡片" }));
    resolveSecond(response({ card: secondCard }));
    const detail = await screen.findByRole("region", { name: "第二张卡片" });
    expect(within(detail).getByRole("heading", { name: "第二张卡片" })).toHaveFocus();

    resolveFirst(response({ card: draftCard }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("region", { name: "第二张卡片" })).toBeInTheDocument();
  });

  it("polls an active manual run until it becomes terminal", async () => {
    vi.useFakeTimers();
    let latestCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) {
        latestCalls += 1;
        const status = latestCalls === 1 ? "completed" : latestCalls === 2 ? "running" : "completed";
        const id = latestCalls === 1 ? "run-1" : "run-2";
        return response({ run: {
          id, localDate: "2026-07-24", status,
          discoveredCount: 20, selectedCount: 5, summarizedCount: status === "completed" ? 5 : 3,
          errorCode: null, errorMessage: null, startedAt: "2026-07-24T00:00:00.000Z",
          finishedAt: status === "completed" ? "2026-07-24T00:01:00.000Z" : null,
        } });
      }
      if (url.includes("/api/cards?status=draft")) return response({ cards: [draftCard] });
      if (url.endsWith("/api/runs") && init?.method === "POST") return response({ run: { id: "run-2" } }, 202);
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "手动运行" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("heading", { name: /运行中/ })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("heading", { name: /已完成/ })).toBeInTheDocument();
    expect(latestCalls).toBe(3);
  });

  it("keeps polling unchanged active runs and refreshes cards after completion", async () => {
    vi.useFakeTimers();
    const newDraft = card({ id: "card-new", titleZh: "运行后出现的新草稿" });
    let latestCalls = 0;
    let draftCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) {
        latestCalls += 1;
        const status = latestCalls < 4 ? (latestCalls === 1 ? "completed" : "running") : "completed";
        return response({ run: {
          id: latestCalls === 1 ? "run-1" : "run-2", localDate: "2026-07-24", status,
          discoveredCount: 20, selectedCount: 5, summarizedCount: 3,
          errorCode: null, errorMessage: null, startedAt: "2026-07-24T00:00:00.000Z", finishedAt: status === "completed" ? "2026-07-24T00:01:00.000Z" : null,
        } });
      }
      if (url.includes("/api/cards?status=draft")) {
        draftCalls += 1;
        return response({ cards: draftCalls === 1 ? [] : [newDraft] });
      }
      if (url.endsWith("/api/runs") && init?.method === "POST") return response({ run: { id: "run-2" } }, 202);
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "手动运行" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(latestCalls).toBe(4);
    expect(screen.getByRole("heading", { name: /已完成/ })).toBeInTheDocument();
    expect(screen.getByText("运行后出现的新草稿")).toBeInTheDocument();
  });

  it("surfaces a terminal run and refreshes cards after an asynchronous response gap", async () => {
    vi.useFakeTimers();
    const terminalDraft = card({ id: "terminal-card", titleZh: "终态刷新后的草稿" });
    let latestCalls = 0;
    let resolveTerminalCards!: (value: Response) => void;
    const terminalCards = new Promise<Response>((resolve) => { resolveTerminalCards = resolve; });
    let draftCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) {
        latestCalls += 1;
        const status = latestCalls === 1 ? "completed" : latestCalls === 2 ? "running" : "completed";
        return response({ run: {
          id: latestCalls === 1 ? "run-1" : "run-2", localDate: "2026-07-24", status,
          discoveredCount: 1, selectedCount: 1, summarizedCount: 1, errorCode: null, errorMessage: null,
          startedAt: "2026-07-24T00:00:00.000Z", finishedAt: status === "completed" ? "2026-07-24T00:01:00.000Z" : null,
        } });
      }
      if (url.includes("/api/cards?status=draft")) {
        draftCalls += 1;
        return draftCalls === 1 ? response({ cards: [] }) : terminalCards;
      }
      if (url.endsWith("/api/runs") && init?.method === "POST") return response({ run: { id: "run-2" } }, 202);
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "手动运行" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("heading", { name: /已完成/ })).toBeInTheDocument();

    resolveTerminalCards(response({ cards: [terminalDraft] }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("终态刷新后的草稿")).toBeInTheDocument();
  });

  it("does not let delayed initial drafts overwrite a terminal refresh", async () => {
    vi.useFakeTimers();
    const staleDraft = card({ id: "initial-stale", titleZh: "运行结束前的旧草稿" });
    const terminalDraft = card({ id: "terminal-fresh", titleZh: "运行结束后的新草稿" });
    let latestCalls = 0;
    let draftCalls = 0;
    let resolveInitialDrafts!: (value: Response) => void;
    const initialDrafts = new Promise<Response>((resolve) => { resolveInitialDrafts = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) {
        latestCalls += 1;
        const status = latestCalls === 1 ? "running" : "completed";
        return response({ run: {
          id: "run-1",
          localDate: "2026-07-24",
          status,
          discoveredCount: 1,
          selectedCount: 1,
          summarizedCount: status === "completed" ? 1 : 0,
          failedCount: 0,
          errorCode: null,
          errorMessage: null,
          startedAt: "2026-07-24T00:00:00.000Z",
          finishedAt: status === "completed" ? "2026-07-24T00:01:00.000Z" : null,
        } });
      }
      if (url.includes("/api/cards?status=draft")) {
        draftCalls += 1;
        return draftCalls === 1
          ? initialDrafts
          : response({ cards: [terminalDraft] });
      }
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(draftCalls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("运行结束后的新草稿")).toBeInTheDocument();

    resolveInitialDrafts(response({ cards: [staleDraft] }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("运行结束后的新草稿")).toBeInTheDocument();
    expect(screen.queryByText("运行结束前的旧草稿")).not.toBeInTheDocument();
  });

  it("does not let a delayed terminal refresh overwrite a newer tab", async () => {
    vi.useFakeTimers();
    const staleDraft = card({ id: "stale-draft", titleZh: "不应覆盖已批准列表的草稿" });
    const approvedCard = card({ id: "approved-card", status: "approved", titleZh: "当前已批准卡片" });
    let latestCalls = 0;
    let resolveTerminalCards!: (value: Response) => void;
    const terminalCards = new Promise<Response>((resolve) => { resolveTerminalCards = resolve; });
    let draftCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) {
        latestCalls += 1;
        const status = latestCalls === 1 ? "completed" : latestCalls === 2 ? "running" : "completed";
        return response({ run: {
          id: latestCalls === 1 ? "run-1" : "run-2", localDate: "2026-07-24", status,
          discoveredCount: 1, selectedCount: 1, summarizedCount: 1, errorCode: null, errorMessage: null,
          startedAt: "2026-07-24T00:00:00.000Z", finishedAt: status === "completed" ? "2026-07-24T00:01:00.000Z" : null,
        } });
      }
      if (url.includes("/api/cards?status=draft")) {
        draftCalls += 1;
        return draftCalls === 1 ? response({ cards: [] }) : terminalCards;
      }
      if (url.includes("/api/cards?status=approved")) return response({ cards: [approvedCard] });
      if (url.endsWith("/api/runs") && init?.method === "POST") return response({ run: { id: "run-2" } }, 202);
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "手动运行" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    fireEvent.click(screen.getByRole("button", { name: "已批准" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("当前已批准卡片")).toBeInTheDocument();

    resolveTerminalCards(response({ cards: [staleDraft] }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("当前已批准卡片")).toBeInTheDocument();
    expect(screen.queryByText("不应覆盖已批准列表的草稿")).not.toBeInTheDocument();
  });

  it("polls regeneration until a changed card is observable", async () => {
    vi.useFakeTimers();
    const replacement = card({
      titleZh: "重新生成的章鱼知识",
      inputHash: "replacement-hash",
      generatedAt: "2026-07-24T00:02:00.000Z",
    });
    let detailCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run: null });
      if (url.includes("/api/cards?status=draft")) return response({ cards: [draftCard] });
      if (url.endsWith("/regenerate") && init?.method === "POST") return response({ card: draftCard }, 202);
      if (url.endsWith("/api/cards/card-1")) {
        detailCalls += 1;
        return response({ card: detailCalls === 1 ? draftCard : replacement });
      }
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: `重新生成 ${draftCard.titleZh}` }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(screen.getByText("重新生成的章鱼知识")).toBeInTheDocument();
    expect(detailCalls).toBe(2);
  });

  it("does not append regenerated drafts after switching to another tab", async () => {
    vi.useFakeTimers();
    const replacement = card({ titleZh: "不应出现在已批准列表的草稿", inputHash: "replacement-hash", generatedAt: "2026-07-24T00:02:00.000Z" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run: null });
      if (url.includes("status=draft")) return response({ cards: [draftCard] });
      if (url.includes("status=approved")) return response({ cards: [] });
      if (url.endsWith("/regenerate") && init?.method === "POST") return response({ card: draftCard }, 202);
      if (url.endsWith("/api/cards/card-1")) return response({ card: replacement });
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: `重新生成 ${draftCard.titleZh}` }));
    fireEvent.click(screen.getByRole("button", { name: "已批准" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(screen.getByRole("heading", { name: "已批准" })).toBeInTheDocument();
    expect(screen.queryByText("不应出现在已批准列表的草稿")).not.toBeInTheDocument();
  });

  it("uses the collector re-enable response instead of the historical run error", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run: {
        id: "run-1", localDate: "2026-07-24", status: "failed",
        discoveredCount: 0, selectedCount: 0, summarizedCount: 0,
        errorCode: "anonymous_disabled", errorMessage: "Collector disabled",
        startedAt: "2026-07-24T00:00:00.000Z", finishedAt: "2026-07-24T00:00:01.000Z",
      } });
      if (url.includes("/api/cards?status=draft")) return response({ cards: [] });
      if (url.endsWith("/api/settings/anonymous-collection") && init?.method === "POST") {
        return response({ anonymousCollection: { enabled: true, consecutiveFailures: 0 } });
      }
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    fireEvent.click(await screen.findByRole("button", { name: "重新启用" }));

    expect(await screen.findByText("匿名采集：正常或待下一次检查")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新启用" })).not.toBeInTheDocument();
  });

  it("keeps a collector re-enable result through an ordinary tab reload", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run: {
        id: "run-1", localDate: "2026-07-24", status: "failed", discoveredCount: 0, selectedCount: 0, summarizedCount: 0,
        errorCode: "anonymous_disabled", errorMessage: "Collector disabled", startedAt: "2026-07-24T00:00:00.000Z", finishedAt: "2026-07-24T00:01:00.000Z",
      } });
      if (url.includes("/api/cards?status=")) return response({ cards: [] });
      if (url.endsWith("/api/settings/anonymous-collection") && init?.method === "POST") return response({ anonymousCollection: { enabled: true, consecutiveFailures: 0 } });
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    fireEvent.click(await screen.findByRole("button", { name: "重新启用" }));
    fireEvent.click(screen.getByRole("button", { name: "已批准" }));

    expect(await screen.findByText("匿名采集：正常或待下一次检查")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新启用" })).not.toBeInTheDocument();
  });

  it("limits status-card actions and never links malformed or non-http sources", async () => {
    const unsafeCard = card({
      id: "card-unsafe",
      status: "approved",
      titleZh: "不安全来源卡片",
      redditUrl: "javascript:alert('reddit')",
      sourceUrl: "not a url",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs/latest")) return response({ run: null });
      if (url.includes("status=draft")) return response({ cards: [] });
      if (url.includes("status=approved")) return response({ cards: [unsafeCard] });
      if (url.endsWith("/api/cards/card-unsafe")) return response({ card: unsafeCard });
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App apiBaseUrl="https://api.example.test" initialAccessKey="secret-key" />);

    fireEvent.click(await screen.findByRole("button", { name: "已批准" }));
    expect(await screen.findByText("已批准的卡片")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批准 不安全来源卡片/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重新生成 不安全来源卡片/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看 不安全来源卡片" }));
    const detail = await screen.findByRole("region", { name: "不安全来源卡片" });
    expect(within(detail).queryByRole("link", { name: "Reddit 原帖" })).not.toBeInTheDocument();
    expect(within(detail).queryByRole("link", { name: "外部来源" })).not.toBeInTheDocument();
    expect(within(detail).getByText("来源地址无效")).toBeInTheDocument();
  });
});
