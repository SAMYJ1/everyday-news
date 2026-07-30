import type { FetchRun } from "../api/client";

interface RunStatusProps {
  run: FetchRun | null;
  runHistory: FetchRun[];
  isStarting: boolean;
  onStart: () => void;
  onEnableAnonymous: () => void;
  isEnablingAnonymous: boolean;
  collectorEnabled?: boolean;
}

const statusLabels = {
  queued: "等待中",
  running: "运行中",
  partial: "部分完成",
  completed: "已完成",
  failed: "失败",
} as const;

export const RUN_STALE_AFTER_MS = 10 * 60 * 1_000;

function isStaleRun(run: FetchRun | null): boolean {
  if (run?.status !== "queued" && run?.status !== "running") return false;
  const startedAt = new Date(run.startedAt).getTime();
  return Number.isFinite(startedAt) &&
    Date.now() - startedAt > RUN_STALE_AFTER_MS;
}

function runStatusLabel(run: FetchRun): string {
  return isStaleRun(run) ? "运行已超时" : statusLabels[run.status];
}

export function RunStatus({ run, runHistory, isStarting, onStart, onEnableAnonymous, isEnablingAnonymous, collectorEnabled }: RunStatusProps) {
  const isActive = run?.status === "queued" || run?.status === "running";
  const isStale = isStaleRun(run);
  const collectorPaused = collectorEnabled === undefined ? run?.errorCode === "anonymous_disabled" : !collectorEnabled;

  return (<>
    <section className="run-status" aria-labelledby="run-status-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">最近一次采集</p>
          <h2 id="run-status-heading">{run ? `${run.localDate} · ${runStatusLabel(run)}` : "尚无运行记录"}</h2>
        </div>
        <button type="button" className="button button-secondary" onClick={onStart} disabled={isStarting || isActive}>
          {isStarting ? "正在启动…" : "手动运行"}
        </button>
      </div>
      {run && <>
        <dl className="run-metrics">
          {[
            ["发现", run.discoveredCount],
            ["入选", run.selectedCount],
            ["已生成", run.summarizedCount],
            ["失败", run.failedCount],
          ].map(([label, count]) => <div key={label}>
            <dt>{label}</dt><dd>{count}</dd>
            <span className="visually-hidden" aria-hidden="true">{label} {count}</span>
          </div>)}
        </dl>
        <div className={collectorPaused ? "collector-status collector-status-paused" : "collector-status"}>
          <span>匿名采集：{collectorPaused ? "已暂停" : "正常或待下一次检查"}</span>
          {collectorPaused && <button type="button" className="text-button" onClick={onEnableAnonymous} disabled={isEnablingAnonymous}>
            {isEnablingAnonymous ? "正在恢复…" : "重新启用"}
          </button>}
        </div>
        {isStale && <p className="run-error" role="status">
          这次运行已超过十分钟，服务器正在确认最终状态。确认完成前暂时不能再次手动运行。
        </p>}
        {run.errorMessage && <p className="run-error" role="status">{run.errorMessage}</p>}
      </>}
    </section>
    <section className="run-history" aria-labelledby="run-history-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">历史采集</p>
          <h2 id="run-history-heading">运行记录</h2>
        </div>
      </div>
      {runHistory.length === 0
        ? <p className="empty-state">暂无运行记录。</p>
        : <ol>
          {runHistory.map((historyRun) => <li key={historyRun.id}>
            <article aria-label={`${historyRun.localDate} 运行记录`}>
              <h3>{historyRun.localDate} · {runStatusLabel(historyRun)}</h3>
              <dl className="run-metrics">
                {[
                  ["发现", historyRun.discoveredCount],
                  ["入选", historyRun.selectedCount],
                  ["已生成", historyRun.summarizedCount],
                  ["失败", historyRun.failedCount],
                ].map(([label, count]) => <div key={label}>
                  <dt>{label}</dt><dd>{count}</dd>
                </div>)}
              </dl>
              {historyRun.errorMessage && <p><strong>最近失败原因：</strong>{historyRun.errorMessage}</p>}
            </article>
          </li>)}
        </ol>}
    </section>
  </>);
}
