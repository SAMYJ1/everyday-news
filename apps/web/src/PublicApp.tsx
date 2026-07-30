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
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [cards, setCards] = useState<PublicKnowledgeCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);

  const loadDate = useCallback(async (date: string) => {
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    const request = ++requestSequence.current;
    setSelectedDate(date);
    setCards([]);
    setLoading(true);
    setError("");
    try {
      const result = await api.listCards(date, { signal: controller.signal });
      if (controller.signal.aborted || request !== requestSequence.current) return;
      setCards(result.cards);
    } catch {
      if (controller.signal.aborted || request !== requestSequence.current) return;
      setError("暂时无法加载今天的知识，请稍后重试。");
    } finally {
      if (!controller.signal.aborted && request === requestSequence.current) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    requestAbort.current = controller;
    const request = ++requestSequence.current;

    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const availableDates = await api.listDates({ signal: controller.signal });
        if (controller.signal.aborted || request !== requestSequence.current) return;
        setDates(availableDates);
        const newestDate = availableDates[0];
        if (newestDate === undefined) {
          setSelectedDate("");
          setCards([]);
          return;
        }
        setSelectedDate(newestDate);
        const result = await api.listCards(newestDate, { signal: controller.signal });
        if (controller.signal.aborted || request !== requestSequence.current) return;
        setCards(result.cards);
      } catch {
        if (controller.signal.aborted || request !== requestSequence.current) return;
        setError("暂时无法加载今天的知识，请稍后重试。");
      } finally {
        if (!controller.signal.aborted && request === requestSequence.current) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => controller.abort();
  }, [api]);

  return <main className="public-app">
    <header className="public-hero">
      <p className="eyebrow">Everyday News · 每日小科普</p>
      <h1>每天一点新知识</h1>
      <p>从社区讨论中整理值得花几分钟了解的小知识，保留来源，也保留必要的谨慎。</p>
      {dates.length > 0 && <div className="public-date-picker">
        <label htmlFor="public-date">选择日期</label>
        <select
          id="public-date"
          value={selectedDate}
          onChange={(event) => void loadDate(event.target.value)}
        >
          {dates.map((date) => <option key={date} value={date}>{date}</option>)}
        </select>
      </div>}
    </header>

    {error && <p className="public-alert" role="alert">{error}</p>}
    {loading
      ? <p className="public-state" role="status">正在整理今天的内容…</p>
      : !error && dates.length === 0
        ? <p className="public-state">今天还没有可阅读的知识，晚些时候再来看看。</p>
        : !error && cards.length === 0
          ? <p className="public-state">这一天还没有可阅读的知识。</p>
          : <section className="public-grid" aria-label={`${selectedDate} 的知识`}>
            {cards.map((card) => <PublicCard key={card.id} card={card} />)}
          </section>}

    <footer className="public-footer">
      <p>内容由 AI 根据原帖与评论整理，不替代专业事实核查。</p>
      <a href="/admin">管理入口</a>
    </footer>
  </main>;
}
