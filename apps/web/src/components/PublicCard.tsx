import type { PublicKnowledgeCard } from "../api/client";

interface PublicCardProps {
  card: PublicKnowledgeCard;
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

function SourceLink({ href, children, unavailable }: {
  href: string | null;
  children: string;
  unavailable: string;
}) {
  const safeHref = safeHttpUrl(href);
  return safeHref === null
    ? <span>{unavailable}</span>
    : <a href={safeHref} target="_blank" rel="noreferrer noopener">{children}</a>;
}

export function PublicCard({ card }: PublicCardProps) {
  return <article className="public-card" aria-label={card.titleZh}>
    <header>
      <p className="eyebrow">{card.runLocalDate}</p>
      <h2>{card.titleZh}</h2>
      {card.titleEn && <p className="public-card-english">{card.titleEn}</p>}
    </header>
    <p className="public-card-fact">{card.oneLineFact}</p>
    <section>
      <h3>为什么有趣</h3>
      <p>{card.whyInteresting}</p>
    </section>
    {card.commentInsights.length > 0 && <section>
      <h3>评论里的补充</h3>
      <ul>
        {card.commentInsights.map((insight) => <li key={insight}>{insight}</li>)}
      </ul>
    </section>}
    {card.caveats.length > 0 && <section className="public-card-caveats">
      <h3>阅读提示</h3>
      <ul>
        {card.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
      </ul>
    </section>}
    <p className="public-card-confidence">{card.confidenceNote}</p>
    <footer className="public-card-links">
      <SourceLink href={card.redditUrl} unavailable="Reddit 原帖不可用">Reddit 原帖</SourceLink>
      <SourceLink href={card.sourceUrl} unavailable="外部来源不可用">外部来源</SourceLink>
    </footer>
  </article>;
}
