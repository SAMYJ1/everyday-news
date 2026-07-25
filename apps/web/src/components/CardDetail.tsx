import { useEffect, useRef } from "react";
import type { KnowledgeCard } from "../api/client";

interface CardDetailProps {
  card: KnowledgeCard;
  onClose: () => void;
}

export function CardDetail({ card, onClose }: CardDetailProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const redditUrl = safeHttpUrl(card.redditUrl);
  const sourceUrl = safeHttpUrl(card.sourceUrl);
  const commentLinks = card.commentLinks
    .map((value, index) => ({ href: safeHttpUrl(value), index }))
    .filter((entry): entry is { href: string; index: number } => entry.href !== null);
  const hasInvalidSource = Boolean((card.redditUrl && !redditUrl) || (card.sourceUrl && !sourceUrl));

  useEffect(() => { titleRef.current?.focus(); }, [card.id]);

  return (
    <section className="card-detail" role="region" aria-labelledby="card-detail-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">卡片详情</p>
          <h2 id="card-detail-title" ref={titleRef} tabIndex={-1}>{card.titleZh}</h2>
        </div>
        <button type="button" className="button button-quiet" onClick={onClose}>关闭</button>
      </div>
      <p className="detail-fact">{card.oneLineFact}</p>
      <section><h3>为什么值得读</h3><p>{card.whyInteresting}</p></section>
      <section><h3>评论补充</h3><ul>{card.commentInsights.map((insight) => <li key={insight}>{insight}</li>)}</ul></section>
      <section><h3>注意与局限</h3><ul>{card.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul></section>
      <section className="confidence-note"><h3>置信说明</h3><p>{card.confidenceNote}</p></section>
      <section><h3>选择原因</h3><p>候选分：{card.candidateScore}</p><ul>
        {card.selectionReasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul></section>
      {card.warnings.length > 0 && <section><h3>运行警告</h3><ul>
        {card.warnings.map((warning) => <li key={`${warning.code}:${warning.message}`}>
          <span>{warning.code}</span>：<span>{warning.message}</span>
        </li>)}
      </ul></section>}
      <section><h3>来源</h3>
        <p className="english-title">{card.titleEn}</p>
        <div className="source-links">
          {redditUrl && <a href={redditUrl} target="_blank" rel="noreferrer noopener">Reddit 原帖</a>}
          {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer noopener">外部来源</a>}
          {hasInvalidSource && <span>来源地址无效</span>}
        </div>
      </section>
      {commentLinks.length > 0 && <section><h3>参与摘要的评论</h3><ul>
        {commentLinks.map(({ href, index }) => <li key={`${href}:${index}`}>
          <a href={href} target="_blank" rel="noreferrer noopener">参与评论 {index + 1}</a>
        </li>)}
      </ul></section>}
      <footer>模型：{card.model} · 提示词：{card.promptVersion} · 生成于 {new Date(card.generatedAt).toLocaleString("zh-CN")}</footer>
    </section>
  );
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
