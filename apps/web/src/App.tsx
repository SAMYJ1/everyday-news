import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient, type CardStatus, type FetchRun, type KnowledgeCard } from "./api/client";
import { CardDetail } from "./components/CardDetail";
import { DraftCard } from "./components/DraftCard";
import { RunStatus } from "./components/RunStatus";

const ACCESS_KEY_STORAGE = "everyday-news-admin-key";

interface AppProps {
  apiBaseUrl?: string;
  initialAccessKey?: string;
}

function storedAccessKey(): string {
  return typeof window === "undefined" ? "" : window.sessionStorage.getItem(ACCESS_KEY_STORAGE) ?? "";
}

export function App({ apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "", initialAccessKey }: AppProps) {
  const [accessKey, setAccessKey] = useState(initialAccessKey ?? storedAccessKey);
  const [keyInput, setKeyInput] = useState("");
  const [status, setStatus] = useState<CardStatus>("draft");
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [detail, setDetail] = useState<KnowledgeCard | null>(null);
  const [run, setRun] = useState<FetchRun | null>(null);
  const [error, setError] = useState("");
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [enablingAnonymous, setEnablingAnonymous] = useState(false);

  const api = useMemo(() => createApiClient(apiBaseUrl, () => accessKey), [apiBaseUrl, accessKey]);
  const loadDashboard = useCallback(async () => {
    if (!accessKey) return;
    setError("");
    try {
      const [latestRun, listedCards] = await Promise.all([api.getLatestRun(), api.listCards(status)]);
      setRun(latestRun);
      setCards(listedCards);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 401 ? "访问密钥无效，请重新输入。" : "无法加载审核数据，请稍后重试。");
    }
  }, [accessKey, api, status]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  function submitAccessKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = keyInput.trim();
    if (!value) return;
    window.sessionStorage.setItem(ACCESS_KEY_STORAGE, value);
    setAccessKey(value);
    setKeyInput("");
  }

  async function review(card: KnowledgeCard, action: "approve" | "reject") {
    setBusyCardId(card.id);
    setError("");
    try {
      const updated = await api[action](card.id);
      setCards((current) => current.filter(({ id }) => id !== updated.id));
      setDetail((current) => current?.id === updated.id ? updated : current);
    } catch {
      setError("审核操作未完成，请重试。");
    } finally {
      setBusyCardId(null);
    }
  }

  async function regenerate(card: KnowledgeCard) {
    setBusyCardId(card.id);
    setError("");
    try {
      await api.regenerate(card.id);
      setCards((current) => current.filter(({ id }) => id !== card.id));
    } catch {
      setError("重新生成请求未发送，请重试。");
    } finally {
      setBusyCardId(null);
    }
  }

  async function openDetail(card: KnowledgeCard) {
    setError("");
    try {
      setDetail(await api.getCard(card.id));
    } catch {
      setError("无法加载卡片详情，请重试。");
    }
  }

  async function startRun() {
    setStartingRun(true);
    setError("");
    try {
      await api.startRun();
      await loadDashboard();
    } catch {
      setError("手动运行未启动，请重试。");
    } finally {
      setStartingRun(false);
    }
  }

  async function enableAnonymous() {
    setEnablingAnonymous(true);
    setError("");
    try {
      await api.setAnonymousCollection(true);
      await loadDashboard();
    } catch {
      setError("无法重新启用匿名采集，请重试。");
    } finally {
      setEnablingAnonymous(false);
    }
  }

  if (!accessKey) {
    return <main className="access-gate">
      <section aria-labelledby="access-title">
        <p className="eyebrow">Everyday News · 私有审核台</p>
        <h1 id="access-title">今天，挑出值得留下的知识。</h1>
        <p>请输入管理员访问密钥。密钥只会保存在当前浏览器会话中。</p>
        <form onSubmit={submitAccessKey}>
          <label htmlFor="admin-key">管理员访问密钥</label>
          <input id="admin-key" name="admin-key" type="text" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} />
          <button type="submit" className="button button-primary">进入审核台</button>
        </form>
      </section>
    </main>;
  }

  return <main className="dashboard">
    <header className="dashboard-header">
      <div><p className="eyebrow">Everyday News · 私有审核台</p><h1>今日审核</h1></div>
      <p>先看这次运行，再处理今天的草稿。</p>
    </header>
    {error && <p className="app-error" role="alert">{error}</p>}
    <RunStatus run={run} isStarting={startingRun} onStart={() => void startRun()} onEnableAnonymous={() => void enableAnonymous()} isEnablingAnonymous={enablingAnonymous} />
    <section className="cards-section" aria-labelledby="cards-heading">
      <div className="section-heading">
        <div><p className="eyebrow">审核队列</p><h2 id="cards-heading">{status === "draft" ? "今日草稿" : status === "approved" ? "已批准" : "已淘汰"}</h2></div>
        <nav aria-label="卡片状态" className="status-tabs">
          {(["draft", "approved", "rejected"] as const).map((candidateStatus) => <button key={candidateStatus} type="button" aria-pressed={status === candidateStatus} onClick={() => { setStatus(candidateStatus); setDetail(null); }}>
            {candidateStatus === "draft" ? "草稿" : candidateStatus === "approved" ? "已批准" : "已淘汰"}
          </button>)}
        </nav>
      </div>
      {cards.length === 0 ? <p className="empty-state">这里暂时没有卡片。</p> : <div className="card-grid">
        {cards.map((card) => <DraftCard key={card.id} card={card} busy={busyCardId === card.id} onApprove={() => void review(card, "approve")} onReject={() => void review(card, "reject")} onRegenerate={() => void regenerate(card)} onView={() => void openDetail(card)} />)}
      </div>}
    </section>
    {detail && <CardDetail card={detail} onClose={() => setDetail(null)} />}
  </main>;
}
