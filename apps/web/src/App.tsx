import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, createApiClient, type FetchRun } from "./api/client";
import { RunStatus } from "./components/RunStatus";

const ACCESS_KEY_STORAGE = "everyday-news-admin-key";

function storedKey(): string {
  return typeof window === "undefined"
    ? ""
    : window.sessionStorage.getItem(ACCESS_KEY_STORAGE) ?? "";
}

export function App({
  apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "",
}: {
  apiBaseUrl?: string;
}) {
  const [adminKey, setAdminKey] = useState(storedKey);
  const [keyInput, setKeyInput] = useState("");
  const [run, setRun] = useState<FetchRun | null>(null);
  const [runHistory, setRunHistory] = useState<FetchRun[]>([]);
  const [loading, setLoading] = useState(adminKey !== "");
  const [isStarting, setIsStarting] = useState(false);
  const [isEnablingAnonymous, setIsEnablingAnonymous] = useState(false);
  const [error, setError] = useState("");
  const api = useMemo(() => createApiClient(apiBaseUrl, () => adminKey), [adminKey, apiBaseUrl]);

  const clearAccess = useCallback(() => {
    window.sessionStorage.removeItem(ACCESS_KEY_STORAGE);
    setAdminKey("");
    setRun(null);
    setRunHistory([]);
  }, []);

  const handleFailure = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) {
      clearAccess();
      setError("访问密钥无效，请重新输入。");
      return;
    }
    setError("暂时无法加载运行状态，请稍后重试。");
  }, [clearAccess]);

  const refresh = useCallback(async () => {
    try {
      const [latest, history] = await Promise.all([
        api.getLatestRun(),
        api.listRuns(),
      ]);
      setRun(latest);
      setRunHistory(history);
      setError("");
    } catch (failure) {
      handleFailure(failure);
    } finally {
      setLoading(false);
    }
  }, [api, handleFailure]);

  useEffect(() => {
    if (adminKey === "") return;
    void refresh();
  }, [adminKey, refresh]);

  useEffect(() => {
    if (adminKey === "" || (run?.status !== "queued" && run?.status !== "running")) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [adminKey, refresh, run?.status]);

  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = keyInput.trim();
    if (value === "") return;
    window.sessionStorage.setItem(ACCESS_KEY_STORAGE, value);
    setAdminKey(value);
    setKeyInput("");
    setLoading(true);
    setError("");
  }

  async function startRun() {
    setIsStarting(true);
    setError("");
    try {
      await api.startRun();
      await refresh();
    } catch (failure) {
      handleFailure(failure);
    } finally {
      setIsStarting(false);
    }
  }

  async function enableAnonymous() {
    setIsEnablingAnonymous(true);
    try {
      await api.setAnonymousCollection(true);
      await refresh();
    } catch (failure) {
      handleFailure(failure);
    } finally {
      setIsEnablingAnonymous(false);
    }
  }

  if (adminKey === "") {
    return <main className="access-gate">
      <section>
        <p className="eyebrow">Everyday News · 运维</p>
        <h1>采集运行状态</h1>
        <p>此页面仅用于查看失败原因、历史记录和启动手动采集。</p>
        {error && <p className="app-error" role="alert">{error}</p>}
        <form onSubmit={unlock}>
          <label htmlFor="admin-key">管理员访问密钥</label>
          <input id="admin-key" name="admin-key" type="password" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} />
          <button className="button button-primary" type="submit">进入运维页</button>
        </form>
      </section>
    </main>;
  }

  return <main className="dashboard">
    <header className="dashboard-header">
      <div>
        <p className="eyebrow">Everyday News · 运维</p>
        <h1>采集运行状态</h1>
      </div>
      <div className="dashboard-header-aside">
        <p>内容发布由 AI 自动筛选，本页不提供人工审核。</p>
        <button type="button" className="text-button" onClick={clearAccess}>退出</button>
        <p className="admin-public-link"><a href="/">返回公开新闻流</a></p>
      </div>
    </header>
    {error && <p className="app-error" role="alert">{error}</p>}
    {loading
      ? <p className="public-state" role="status">正在加载运行状态…</p>
      : <RunStatus
          run={run}
          runHistory={runHistory}
          isStarting={isStarting}
          onStart={() => void startRun()}
          onEnableAnonymous={() => void enableAnonymous()}
          isEnablingAnonymous={isEnablingAnonymous}
        />}
  </main>;
}
