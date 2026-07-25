import type { KnowledgeCard } from "../api/client";

interface DraftCardProps {
  card: KnowledgeCard;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRegenerate: () => void;
  onView: () => void;
}

export function DraftCard({ card, busy, onApprove, onReject, onRegenerate, onView }: DraftCardProps) {
  const sourceHost = safeSourceHost(card.sourceUrl);
  const statusLabel = card.status === "draft" ? "草稿" : card.status === "approved" ? "已批准的卡片" : "已淘汰的卡片";
  return (
    <article className="draft-card">
      <p className="eyebrow">{statusLabel}</p>
      <h3>{card.titleZh}</h3>
      <p className="card-fact">{card.oneLineFact}</p>
      <p className="card-source">{sourceHost ?? (card.sourceUrl ? "来源地址无效" : "未提供外部来源")}</p>
      <div className="card-actions">
        {card.status === "draft" && <>
          <button type="button" className="button button-primary" aria-label={`批准 ${card.titleZh}`} onClick={onApprove} disabled={busy}>批准</button>
          <button type="button" className="button button-secondary" aria-label={`淘汰 ${card.titleZh}`} onClick={onReject} disabled={busy}>淘汰</button>
          <button type="button" className="button button-quiet" aria-label={`重新生成 ${card.titleZh}`} onClick={onRegenerate} disabled={busy}>重新生成</button>
        </>}
        <button type="button" className="text-button" aria-label={`查看 ${card.titleZh}`} onClick={onView}>查看详情</button>
      </div>
    </article>
  );
}

function safeSourceHost(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}
