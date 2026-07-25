import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApiClient, type CardStatus, type FetchRun, type KnowledgeCard } from "./api/client";
import { CardDetail } from "./components/CardDetail";
import { DraftCard } from "./components/DraftCard";
import { RunStatus } from "./components/RunStatus";

const ACCESS_KEY_STORAGE = "everyday-news-admin-key";
const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_ATTEMPTS = 60;

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
  const [historyDate, setHistoryDate] = useState("");
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [detail, setDetail] = useState<KnowledgeCard | null>(null);
  const [run, setRun] = useState<FetchRun | null>(null);
  const [runHistory, setRunHistory] = useState<FetchRun[]>([]);
  const [error, setError] = useState("");
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [enablingAnonymous, setEnablingAnonymous] = useState(false);
  const [collectorEnabled, setCollectorEnabled] = useState<boolean | undefined>();
  const statusRef = useRef(status);
  const historyDateRef = useRef(historyDate);
  const runLocalDateRef = useRef("");
  const runHistoryFilterRef = useRef<string | undefined>(undefined);
  const runHistoryRequest = useRef(0);
  const runHistoryAbort = useRef<AbortController | null>(null);
  const dashboardRequest = useRef(0);
  const dashboardAbort = useRef<AbortController | null>(null);
  const detailRequest = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  const regenerateRequest = useRef(0);
  const regenerateAbort = useRef<AbortController | null>(null);
  const regenerateTimer = useRef<number | null>(null);
  const terminalRefreshRequest = useRef(0);
  const terminalRefreshAbort = useRef<AbortController | null>(null);

  const api = useMemo(() => createApiClient(apiBaseUrl, () => accessKey), [apiBaseUrl, accessKey]);
  const clearAccessKey = useCallback(() => {
    window.sessionStorage.removeItem(ACCESS_KEY_STORAGE);
    dashboardAbort.current?.abort();
    runHistoryAbort.current?.abort();
    runHistoryRequest.current += 1;
    detailAbort.current?.abort();
    regenerateAbort.current?.abort();
    terminalRefreshAbort.current?.abort();
    if (regenerateTimer.current !== null) window.clearInterval(regenerateTimer.current);
    setAccessKey("");
    setKeyInput("");
    statusRef.current = "draft";
    setStatus("draft");
    setCards([]);
    setDetail(null);
    setRun(null);
    setRunHistory([]);
    setHistoryDate("");
    historyDateRef.current = "";
    runLocalDateRef.current = "";
    setCollectorEnabled(undefined);
    setError("访问密钥无效，请重新输入。");
  }, []);

  const loadRunHistory = useCallback(async (requestedDate?: string) => {
    if (!accessKey) return;
    runHistoryAbort.current?.abort();
    const controller = new AbortController();
    runHistoryAbort.current = controller;
    const request = ++runHistoryRequest.current;
    runHistoryFilterRef.current = requestedDate;
    setRunHistory([]);
    try {
      const runs = await api.listRuns(requestedDate, { signal: controller.signal });
      if (
        controller.signal.aborted ||
        request !== runHistoryRequest.current ||
        runHistoryFilterRef.current !== requestedDate
      ) return;
      setRunHistory(runs);
    } catch (caught) {
      if (controller.signal.aborted || request !== runHistoryRequest.current) return;
      if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
    }
  }, [accessKey, api, clearAccessKey]);

  const loadCards = useCallback(async (requestedStatus: CardStatus, requestedDate?: string) => {
    if (!accessKey) return;
    dashboardAbort.current?.abort();
    const controller = new AbortController();
    dashboardAbort.current = controller;
    const request = ++dashboardRequest.current;
    setError("");
    try {
      const listedCards = requestedDate === undefined
        ? await api.listCards(requestedStatus, { signal: controller.signal })
        : await api.listCards(requestedStatus, requestedDate, { signal: controller.signal });
      const currentDate = requestedStatus === "draft"
        ? runLocalDateRef.current
        : historyDateRef.current;
      if (
        request !== dashboardRequest.current ||
        controller.signal.aborted ||
        statusRef.current !== requestedStatus ||
        currentDate !== (requestedDate ?? "")
      ) return;
      setCards(listedCards);
    } catch (caught) {
      if (controller.signal.aborted || request !== dashboardRequest.current) return;
      if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
      else setError("无法加载审核数据，请稍后重试。");
    }
  }, [accessKey, api, clearAccessKey]);

  const loadDashboard = useCallback(async () => {
    if (!accessKey) return;
    dashboardAbort.current?.abort();
    const controller = new AbortController();
    dashboardAbort.current = controller;
    const request = ++dashboardRequest.current;
    setError("");
    try {
      const latestRun = await api.getLatestRun({ signal: controller.signal });
      if (request !== dashboardRequest.current || controller.signal.aborted) return;
      const localDate = latestRun?.localDate ?? "";
      runLocalDateRef.current = localDate;
      historyDateRef.current = localDate;
      setRun(latestRun);
      setHistoryDate(localDate);
      const listedCardsPromise = localDate === ""
        ? api.listCards("draft", { signal: controller.signal })
        : api.listCards("draft", localDate, { signal: controller.signal });
      void loadRunHistory();
      const listedCards = await listedCardsPromise;
      if (
        request !== dashboardRequest.current ||
        controller.signal.aborted ||
        statusRef.current !== "draft"
      ) return;
      setCards(listedCards);
    } catch (caught) {
      if (controller.signal.aborted || request !== dashboardRequest.current) return;
      if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
      else setError("无法加载审核数据，请稍后重试。");
    }
  }, [accessKey, api, clearAccessKey, loadRunHistory]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => () => {
    dashboardAbort.current?.abort();
    runHistoryAbort.current?.abort();
    detailAbort.current?.abort();
    regenerateAbort.current?.abort();
    terminalRefreshAbort.current?.abort();
    if (regenerateTimer.current !== null) window.clearInterval(regenerateTimer.current);
  }, []);

  useEffect(() => {
    if (run?.status !== "queued" && run?.status !== "running") return;
    let attempts = 0;
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (cancelled || attempts++ >= MAX_POLL_ATTEMPTS) return;
      try {
        const latestRun = await api.getLatestRun({ signal: controller.signal });
        if (cancelled) return;
        runLocalDateRef.current = latestRun?.localDate ?? "";
        setRun(latestRun);
        if (latestRun?.status === "queued" || latestRun?.status === "running") {
          timer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
        } else {
          setRun(latestRun);
          dashboardAbort.current?.abort();
          dashboardRequest.current += 1;
          terminalRefreshAbort.current?.abort();
          const terminalController = new AbortController();
          terminalRefreshAbort.current = terminalController;
          const refreshRequest = ++terminalRefreshRequest.current;
          const refreshStatus = statusRef.current;
          const refreshDate = refreshStatus === "draft"
            ? latestRun?.localDate ?? ""
            : historyDateRef.current;
          if (refreshStatus === "draft") {
            historyDateRef.current = refreshDate;
            setHistoryDate(refreshDate);
          }
          const refresh = refreshDate === ""
            ? api.listCards(refreshStatus, { signal: terminalController.signal })
            : api.listCards(refreshStatus, refreshDate, { signal: terminalController.signal });
          void loadRunHistory(runHistoryFilterRef.current);
          void refresh.then((refreshedCards) => {
            const currentDate = refreshStatus === "draft"
              ? runLocalDateRef.current
              : historyDateRef.current;
            if (
              !terminalController.signal.aborted &&
              refreshRequest === terminalRefreshRequest.current &&
              statusRef.current === refreshStatus &&
              currentDate === refreshDate
            ) {
              setCards(refreshedCards);
            }
          }).catch((caught) => {
            if (!terminalController.signal.aborted && caught instanceof ApiError && caught.status === 401) clearAccessKey();
          });
        }
      } catch (caught) {
        if (!cancelled && caught instanceof ApiError && caught.status === 401) clearAccessKey();
      }
    };
    timer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [api, clearAccessKey, loadRunHistory, run?.id, run?.status]);

  function submitAccessKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = keyInput.trim();
    if (!value) return;
    window.sessionStorage.setItem(ACCESS_KEY_STORAGE, value);
    setCollectorEnabled(undefined);
    statusRef.current = "draft";
    setStatus("draft");
    historyDateRef.current = "";
    setHistoryDate("");
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
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
      else setError("审核操作未完成，请重试。");
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
      regenerateAbort.current?.abort();
      if (regenerateTimer.current !== null) window.clearInterval(regenerateTimer.current);
      const controller = new AbortController();
      regenerateAbort.current = controller;
      const request = ++regenerateRequest.current;
      const baseline = `${card.inputHash}:${card.generatedAt}`;
      let attempts = 0;
      const poll = async () => {
        if (controller.signal.aborted || request !== regenerateRequest.current || attempts++ >= MAX_POLL_ATTEMPTS) {
          if (regenerateTimer.current !== null) window.clearInterval(regenerateTimer.current);
          return;
        }
        try {
          const updated = await api.getCard(card.id, { signal: controller.signal });
          if (controller.signal.aborted || request !== regenerateRequest.current) return;
          if (`${updated.inputHash}:${updated.generatedAt}` !== baseline) {
            if (regenerateTimer.current !== null) window.clearInterval(regenerateTimer.current);
            const selectedDate = statusRef.current === "draft"
              ? runLocalDateRef.current
              : historyDateRef.current;
            setCards((current) => current.some((candidate) => candidate.id === updated.id)
              ? current.map((candidate) => candidate.id === updated.id ? updated : candidate)
              : updated.status === statusRef.current &&
                  (selectedDate === "" || updated.runLocalDate === selectedDate)
                ? [...current, updated]
                : current);
            setDetail((current) => current?.id === updated.id ? updated : current);
            return;
          }
        } catch (caught) {
          if (controller.signal.aborted || request !== regenerateRequest.current) return;
          if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
        }
      };
      regenerateTimer.current = window.setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
      else setError("重新生成请求未发送，请重试。");
    } finally {
      setBusyCardId(null);
    }
  }

  async function openDetail(card: KnowledgeCard) {
    setError("");
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    const request = ++detailRequest.current;
    try {
      const loaded = await api.getCard(card.id, { signal: controller.signal });
      if (request === detailRequest.current && !controller.signal.aborted) setDetail(loaded);
    } catch (caught) {
      if (controller.signal.aborted || request !== detailRequest.current) return;
      if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
      else setError("无法加载卡片详情，请重试。");
    }
  }

  async function startRun() {
    setStartingRun(true);
    setError("");
    try {
      await api.startRun();
      const latestRun = await api.getLatestRun();
      runLocalDateRef.current = latestRun?.localDate ?? "";
      setRun(latestRun);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
      else setError("手动运行未启动，请重试。");
    } finally {
      setStartingRun(false);
    }
  }

  async function enableAnonymous() {
    setEnablingAnonymous(true);
    setError("");
    try {
      const updated = await api.setAnonymousCollection(true);
      setCollectorEnabled(updated.enabled);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) clearAccessKey();
      else setError("无法重新启用匿名采集，请重试。");
    } finally {
      setEnablingAnonymous(false);
    }
  }

  function selectStatus(candidateStatus: CardStatus) {
    terminalRefreshAbort.current?.abort();
    terminalRefreshRequest.current += 1;
    detailAbort.current?.abort();
    detailRequest.current += 1;
    statusRef.current = candidateStatus;
    setStatus(candidateStatus);
    setDetail(null);
    const requestedDate = candidateStatus === "draft"
      ? runLocalDateRef.current
      : historyDateRef.current;
    void loadCards(candidateStatus, requestedDate || undefined);
  }

  function selectHistoryDate(value: string) {
    terminalRefreshAbort.current?.abort();
    terminalRefreshRequest.current += 1;
    detailAbort.current?.abort();
    detailRequest.current += 1;
    setDetail(null);
    historyDateRef.current = value;
    setHistoryDate(value);
    void loadRunHistory(value || undefined);
    if (statusRef.current !== "draft") {
      void loadCards(statusRef.current, value || undefined);
    }
  }

  if (!accessKey) {
    return <main className="access-gate">
      <section aria-labelledby="access-title">
        <p className="eyebrow">Everyday News · 私有审核台</p>
        <h1 id="access-title">今天，挑出值得留下的知识。</h1>
        <p>请输入管理员访问密钥。密钥只会保存在当前浏览器会话中。</p>
        {error && <p className="app-error" role="alert">{error}</p>}
        <form onSubmit={submitAccessKey}>
          <label htmlFor="admin-key">管理员访问密钥</label>
          <input id="admin-key" name="admin-key" type="password" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} />
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
    <RunStatus run={run} runHistory={runHistory} isStarting={startingRun} onStart={() => void startRun()} onEnableAnonymous={() => void enableAnonymous()} isEnablingAnonymous={enablingAnonymous} collectorEnabled={collectorEnabled} />
    <section className="cards-section" aria-labelledby="cards-heading">
      <div className="section-heading">
        <div><p className="eyebrow">审核队列</p><h2 id="cards-heading">{status === "draft" ? "今日草稿" : status === "approved" ? "已批准" : "已淘汰"}</h2></div>
        <nav aria-label="卡片状态" className="status-tabs">
          {(["draft", "approved", "rejected"] as const).map((candidateStatus) => <button key={candidateStatus} type="button" aria-pressed={status === candidateStatus} onClick={() => selectStatus(candidateStatus)}>
            {candidateStatus === "draft" ? "草稿" : candidateStatus === "approved" ? "已批准" : "已淘汰"}
          </button>)}
        </nav>
      </div>
      {status !== "draft" && <div>
        <label htmlFor="history-date">历史日期</label>
        <input
          id="history-date"
          name="history-date"
          type="date"
          value={historyDate}
          onChange={(event) => selectHistoryDate(event.target.value)}
        />
      </div>}
      {cards.length === 0 ? <p className="empty-state">这里暂时没有卡片。</p> : <div className="card-grid">
        {cards.map((card) => <DraftCard key={card.id} card={card} busy={busyCardId === card.id} onApprove={() => void review(card, "approve")} onReject={() => void review(card, "reject")} onRegenerate={() => void regenerate(card)} onView={() => void openDetail(card)} />)}
      </div>}
    </section>
    {detail && <CardDetail card={detail} onClose={() => setDetail(null)} />}
  </main>;
}
