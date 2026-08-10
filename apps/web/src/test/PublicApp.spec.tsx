// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicApp } from "../PublicApp";

const publicCard = {
  id: "card-new", status: "approved" as const, titleZh: "章鱼会使用工具",
  oneLineFact: "原帖声称一些章鱼会携带椰子壳作为临时庇护所。",
  whyInteresting: "这展示了无脊椎动物也能规划未来用途。",
  commentInsights: [
    { text: "评论补充了观察发生的海域。", redditUrl: "https://reddit.example.test/comment" },
    { text: "另一条评论讨论了工具定义。", redditUrl: null },
  ],
  caveats: ["内容尚未独立核查。"], confidenceNote: "内容仅基于原帖与评论。",
  generatedAt: "2026-08-01T08:00:00.000Z", titleEn: "Octopuses use tools",
  redditUrl: "https://reddit.example.test/post", sourceUrl: "https://source.example.test/article",
  runLocalDate: "2026-08-01",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("PublicApp", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("renders a continuous feed without a date selector and loads an older page", async () => {
    const older = { ...publicCard, id: "card-old", titleZh: "较早的一条知识", runLocalDate: "2026-07-31" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("cursor=")
      ? response({ cards: [older], nextCursor: null })
      : response({ cards: [publicCard], nextCursor: "next-page" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicApp apiBaseUrl="https://api.example.test" />);

    const article = await screen.findByRole("article", { name: publicCard.titleZh });
    expect(screen.queryByLabelText("选择日期")).not.toBeInTheDocument();
    expect(within(article).getByText(publicCard.oneLineFact)).toBeInTheDocument();
    expect(within(article).queryByRole("heading", { name: "值得一看" })).not.toBeInTheDocument();
    const expandButton = within(article).getByRole("button", { name: "展开阅读" });
    expect(expandButton).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expandButton);
    expect(within(article).getByRole("heading", { name: "值得一看" })).toBeInTheDocument();
    expect(within(article).getByRole("heading", { name: "精选评论" })).toBeInTheDocument();
    expect(within(article).getByRole("link", { name: "查看评论" })).toHaveAttribute("href", "https://reddit.example.test/comment");
    expect(within(article).getByRole("button", { name: "收起内容" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "加载更早内容" }));
    expect(await screen.findByRole("article", { name: older.titleZh })).toBeInTheDocument();
  });

  it("shows an empty state and a recoverable error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ cards: [], nextCursor: null })));
    const { unmount } = render(<PublicApp apiBaseUrl="https://api.example.test" />);
    expect(await screen.findByText("暂时还没有可阅读的知识，晚些时候再来看看。")).toBeInTheDocument();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: { code: "unavailable", message: "Unavailable" } }, 503)));
    render(<PublicApp apiBaseUrl="https://api.example.test" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法加载知识流");
  });

  it("renders unsafe source and comment URLs as unavailable text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      cards: [{ ...publicCard, redditUrl: "javascript:alert(1)", sourceUrl: "ftp://bad", commentInsights: [{ text: "评论观点完整但链接不安全。", redditUrl: "javascript:bad" }] }],
      nextCursor: null,
    })));
    render(<PublicApp apiBaseUrl="https://api.example.test" />);
    const article = await screen.findByRole("article", { name: publicCard.titleZh });
    fireEvent.click(within(article).getByRole("button", { name: "展开阅读" }));
    expect(within(article).getByText("对应评论不可用")).toBeInTheDocument();
    expect(within(article).getByText("Reddit 原帖不可用")).toBeInTheDocument();
    expect(within(article).getByText("外部来源不可用")).toBeInTheDocument();
  });
});
