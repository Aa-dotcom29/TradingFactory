import { sentimentTone, severityTone, timeAgo, istStamp, pct, isNum } from '@/lib/format';

export default function NewsList({ items = [], emptyHint = 'No scored news yet.' }) {
  if (!items.length) {
    return (
      <div className="empty">
        <strong>No news in the window</strong>
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="news">
      {items.map((item) => {
        const entities = Array.isArray(item.entities) ? item.entities : [];
        const sentiment = Number(item.sentiment);
        return (
          <article className="news-item" key={item.id}>
            <div className="news-meta">
              <div>{timeAgo(item.published_at)}</div>
              <div className="muted">{istStamp(item.published_at)}</div>
            </div>
            <div>
              <div className="news-title">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer noopener">
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
              </div>
              {item.summary ? <p className="news-sum">{item.summary}</p> : null}
              <div className="news-tags">
                <span className="pill muted">{item.source}</span>
                {item.severity ? <span className={`pill ${severityTone(item.severity)}`}>{item.severity}</span> : null}
                {isNum(item.sentiment) ? (
                  <span className={`pill ${sentimentTone(item.sentiment)}`}>sentiment {pct(sentiment * 100, 0)}</span>
                ) : null}
                {isNum(item.relevance) ? (
                  <span className="pill muted">relevance {Math.round(Number(item.relevance) * 100)}%</span>
                ) : null}
                {entities.slice(0, 6).map((e) => (
                  <span className="pill accent" key={typeof e === 'string' ? e : e.symbol || JSON.stringify(e)}>
                    {typeof e === 'string' ? e : e.symbol || e.name}
                  </span>
                ))}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
