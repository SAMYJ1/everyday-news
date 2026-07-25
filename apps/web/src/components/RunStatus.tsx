import type { FetchRun } from "../api/client";

interface RunStatusProps {
  run: FetchRun | null;
  isStarting: boolean;
  onStart: () => void;
  onEnableAnonymous: () => void;
  isEnablingAnonymous: boolean;
}

const statusLabels = {
  queued: "等待中",
  running: "运行中",
  partial: "部分完成",
  completed: "已完成",
  failed: "失败",
} as const;

export function RunStatus({ run, isStarting, onStart, onEnableAnonymous, isEnablingAnonymous }: RunStatusProps) {
  const isActive = run?.status === "queued" || run?.status === "running";
  const collectorPaused = run?.errorCode === "anonymous_disabled";

  return (
    <section className="run-status" aria-labelledby="run-status-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">最近一次采集</p>
          <h2 id="run-status-heading">{run ? `${run.localDate} · ${statusLabels[run.status]}` : "尚无运行记录"}</h2>
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
        {run.errorMessage && <p className="run-error" role="status">{run.errorMessage}</p>}
      </>}
    </section>
  );
}
