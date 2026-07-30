// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicApp } from "../PublicApp";

const publicCard = {
  id: "card-new",
  status: "draft",
  titleZh: "章鱼会使用工具",
  oneLineFact: "一些章鱼会携带椰子壳作为临时庇护所。",
  whyInteresting: "这展示了无脊椎动物也能规划未来用途。",
  commentInsights: ["评论补充了观察发生的海域。"],
  caveats: ["内容基于原帖与评论整理，尚未独立核查。"],
  confidenceNote: "原帖与高赞评论的描述一致。",
  generatedAt: "2026-07-24T08:00:00.000Z",
  titleEn: "Octopuses use tools",
  redditUrl: "https://reddit.example.test/post",
  sourceUrl: "https://source.example.test/article",
  runLocalDate: "2026-07-24",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PublicApp", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the newest date and switches to an older date", async () => {
    const oldCard = {
      ...publicCard,
      id: "card-old",
      titleZh: "较早的一条知识",
      runLocalDate: "2026-07-23",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/public/dates")) {
        return response({ dates: ["2026-07-24", "2026-07-23"] });
      }
      if (url.endsWith("/api/public/cards?date=2026-07-24")) {
        return response({ date: "2026-07-24", cards: [publicCard] });
      }
      if (url.endsWith("/api/public/cards?date=2026-07-23")) {
        return response({ date: "2026-07-23", cards: [oldCard] });
      }
      return response({ error: { code: "not_found", message: "Missing fixture" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PublicApp apiBaseUrl="https://api.example.test" />);

    expect(await screen.findByRole("heading", { name: publicCard.titleZh })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("选择日期"), {
      target: { value: "2026-07-23" },
    });
    expect(await screen.findByRole("heading", { name: oldCard.titleZh })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: publicCard.titleZh })).not.toBeInTheDocument();
  });

  it("shows an empty state when no public dates exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ dates: [] })));

    render(<PublicApp apiBaseUrl="https://api.example.test" />);

    expect(await screen.findByText("今天还没有可阅读的知识，晚些时候再来看看。")).toBeInTheDocument();
  });

  it("shows a recoverable alert when loading fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      error: { code: "unavailable", message: "Unavailable" },
    }, 503)));

    render(<PublicApp apiBaseUrl="https://api.example.test" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法加载");
  });

  it("renders unsafe source URLs as plain unavailable text", async () => {
    const unsafeCards = [
      {
        ...publicCard,
        id: "javascript-card",
        titleZh: "脚本地址",
        redditUrl: "javascript:alert(1)",
        sourceUrl: "ftp://source.example.test/file",
      },
      {
        ...publicCard,
        id: "malformed-card",
        titleZh: "格式错误地址",
        redditUrl: "not a url",
        sourceUrl: "://broken",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return String(input).endsWith("/api/public/dates")
        ? response({ dates: ["2026-07-24"] })
        : response({ date: "2026-07-24", cards: unsafeCards });
    }));

    render(<PublicApp apiBaseUrl="https://api.example.test" />);

    for (const title of ["脚本地址", "格式错误地址"]) {
      const article = await screen.findByRole("article", { name: title });
      expect(within(article).queryByRole("link")).not.toBeInTheDocument();
      expect(within(article).getByText("Reddit 原帖不可用")).toBeInTheDocument();
      expect(within(article).getByText("外部来源不可用")).toBeInTheDocument();
    }
  });

  it("does not let a slower old-date response replace the latest selection", async () => {
    let resolveOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const newest = { ...publicCard, id: "newest-card", titleZh: "最新选择" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/public/dates")) {
        return response({ dates: ["2026-07-24", "2026-07-23"] });
      }
      if (url.endsWith("date=2026-07-24")) {
        return fetchMock.mock.calls.filter(([value]) => String(value).endsWith("date=2026-07-24")).length === 1
          ? response({ date: "2026-07-24", cards: [publicCard] })
          : response({ date: "2026-07-24", cards: [newest] });
      }
      if (url.endsWith("date=2026-07-23")) return oldResponse;
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicApp apiBaseUrl="https://api.example.test" />);
    await screen.findByText(publicCard.titleZh);

    const select = screen.getByLabelText("选择日期");
    fireEvent.change(select, { target: { value: "2026-07-23" } });
    fireEvent.change(select, { target: { value: "2026-07-24" } });
    expect(await screen.findByText("最新选择")).toBeInTheDocument();

    resolveOld(response({
      date: "2026-07-23",
      cards: [{ ...publicCard, id: "old", titleZh: "过期响应" }],
    }));
    await waitFor(() => expect(screen.queryByText("过期响应")).not.toBeInTheDocument());
  });
});
