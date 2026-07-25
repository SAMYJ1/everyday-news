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
  return (
    <article className="draft-card">
      <p className="eyebrow">草稿</p>
      <h3>{card.titleZh}</h3>
      <p className="card-fact">{card.oneLineFact}</p>
      <p className="card-source">{card.sourceUrl ? new URL(card.sourceUrl).hostname : "未提供外部来源"}</p>
      <div className="card-actions">
        <button type="button" className="button button-primary" aria-label={`批准 ${card.titleZh}`} onClick={onApprove} disabled={busy}>批准</button>
        <button type="button" className="button button-secondary" aria-label={`淘汰 ${card.titleZh}`} onClick={onReject} disabled={busy}>淘汰</button>
        <button type="button" className="button button-quiet" aria-label={`重新生成 ${card.titleZh}`} onClick={onRegenerate} disabled={busy}>重新生成</button>
        <button type="button" className="text-button" aria-label={`查看 ${card.titleZh}`} onClick={onView}>查看详情</button>
      </div>
    </article>
  );
}
