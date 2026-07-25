import type { KnowledgeCard } from "../api/client";

interface CardDetailProps {
  card: KnowledgeCard;
  onClose: () => void;
}

export function CardDetail({ card, onClose }: CardDetailProps) {
  return (
    <section className="card-detail" aria-labelledby="card-detail-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">卡片详情</p>
          <h2 id="card-detail-title">{card.titleZh}</h2>
        </div>
        <button type="button" className="button button-quiet" onClick={onClose}>关闭</button>
      </div>
      <p className="detail-fact">{card.oneLineFact}</p>
      <section><h3>为什么值得读</h3><p>{card.whyInteresting}</p></section>
      <section><h3>评论补充</h3><ul>{card.commentInsights.map((insight) => <li key={insight}>{insight}</li>)}</ul></section>
      <section><h3>注意与局限</h3><ul>{card.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul></section>
      <section className="confidence-note"><h3>置信说明</h3><p>{card.confidenceNote}</p></section>
      <section><h3>来源</h3>
        <p className="english-title">{card.titleEn}</p>
        <div className="source-links">
          <a href={card.redditUrl} target="_blank" rel="noreferrer noopener">Reddit 原帖</a>
          {card.sourceUrl && <a href={card.sourceUrl} target="_blank" rel="noreferrer noopener">外部来源</a>}
        </div>
      </section>
      <footer>模型：{card.model} · 提示词：{card.promptVersion} · 生成于 {new Date(card.generatedAt).toLocaleString("zh-CN")}</footer>
    </section>
  );
}
