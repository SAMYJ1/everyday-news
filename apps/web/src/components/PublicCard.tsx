import { useId, useState } from "react";
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
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  return <article className="public-card" aria-label={card.titleZh}>
    <header>
      <p className="eyebrow">{card.runLocalDate}</p>
      <h2>{card.titleZh}</h2>
    </header>
    <p className="public-card-fact">{card.oneLineFact}</p>
    <button
      type="button"
      className="public-card-toggle"
      aria-expanded={expanded}
      aria-controls={detailsId}
      onClick={() => setExpanded((current) => !current)}
    >
      <span>{expanded ? "收起内容" : "展开阅读"}</span>
      <svg aria-hidden="true" viewBox="0 0 20 20">
        <path d="m5.75 7.5 4.25 4.25 4.25-4.25" />
      </svg>
    </button>
    <div id={detailsId} className="public-card-details" hidden={!expanded}>
      <section>
        <h3>值得一看</h3>
        <p>{card.whyInteresting}</p>
      </section>
      {card.commentInsights.length > 0 && <section>
        <h3>精选评论</h3>
        <ul>
          {card.commentInsights.map((insight, index) => <li key={`${insight.text}-${index}`}>
            {insight.text}{" "}
            <SourceLink href={insight.redditUrl} unavailable="对应评论不可用">查看评论</SourceLink>
          </li>)}
        </ul>
      </section>}
      <footer className="public-card-meta">
        {card.titleEn && <p className="public-card-english">{card.titleEn}</p>}
        {card.caveats.length > 0 && <p>{card.caveats.join(" · ")}</p>}
        <p>{card.confidenceNote}</p>
        <div className="public-card-links">
          <SourceLink href={card.redditUrl} unavailable="Reddit 原帖不可用">Reddit 原帖</SourceLink>
          <SourceLink href={card.sourceUrl} unavailable="外部来源不可用">外部来源</SourceLink>
        </div>
      </footer>
    </div>
  </article>;
}
