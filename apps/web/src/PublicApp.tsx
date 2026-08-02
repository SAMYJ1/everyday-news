import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicApiClient,
  type PublicKnowledgeCard,
} from "./api/client";
import { PublicCard } from "./components/PublicCard";

interface PublicAppProps {
  apiBaseUrl?: string;
}

export function PublicApp({
  apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "",
}: PublicAppProps) {
  const api = useMemo(() => createPublicApiClient(apiBaseUrl), [apiBaseUrl]);
  const [cards, setCards] = useState<PublicKnowledgeCard[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const sentinel = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.listCards(nextCursor);
      setCards((current) => [...current, ...result.cards]);
      setNextCursor(result.nextCursor);
    } catch {
      setError("暂时无法加载更早的内容，请稍后重试。");
    } finally {
      setLoadingMore(false);
    }
  }, [api, loadingMore, nextCursor]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api.listCards(undefined, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setCards(result.cards);
        setNextCursor(result.nextCursor);
      } catch {
        if (controller.signal.aborted) return;
        setError("暂时无法加载知识流，请稍后重试。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (nextCursor === null || sentinel.current === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void loadMore();
    }, { rootMargin: "240px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  return <main className="public-app">
    <header className="public-hero">
      <p className="eyebrow">Everyday News · 每日小科普</p>
      <h1>每天一点新知识</h1>
      <p>从社区讨论中整理值得花几分钟了解的小知识，保留来源，也保留必要的谨慎。</p>
    </header>

    {error && <p className="public-alert" role="alert">{error}</p>}
    {loading
      ? <p className="public-state" role="status">正在整理今天的内容…</p>
      : !error && cards.length === 0
        ? <p className="public-state">暂时还没有可阅读的知识，晚些时候再来看看。</p>
        : <>
          <section className="public-feed" aria-label="知识新闻流">
            {cards.map((card) => <PublicCard key={card.id} card={card} />)}
          </section>
          {nextCursor !== null && <div className="feed-sentinel" ref={sentinel}>
            <button type="button" className="button button-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "正在加载…" : "加载更早内容"}
            </button>
          </div>}
        </>}

    <footer className="public-footer">
      <p>内容由 AI 根据原帖与评论整理，不替代专业事实核查。</p>
      <a href="/admin">管理入口</a>
    </footer>
  </main>;
}
