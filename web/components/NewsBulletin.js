'use client';

import { useEffect, useState } from 'react';
import { istStamp, timeAgo } from '@/lib/format';

// The news bulletin: a running ticker under the rail.
//
// It answers "what is happening right now" without stealing the page. The
// track is the same list twice, and the animation slides exactly one copy, so
// the loop is seamless. It pauses on hover, because a reader who reaches for a
// headline must be able to read it.
//
// Everything shown is a real scored headline from the database. There is no
// filler and no invented urgency: a headline with no severity reads as plain
// text, and the timestamp is the exchange time, not the ingest time.

const SEVERITIES = ['CRITICAL', 'HIGH'];

function Item({ item }) {
  const severity = String(item.severity || '').toUpperCase();
  const flagged = SEVERITIES.includes(severity);
  return (
    <span className="bulletin-item">
      <span className="bulletin-time">{timeAgo(item.published_at)}</span>
      {flagged ? <span className={`bulletin-sev ${severity}`}>{severity}</span> : null}
      {item.url ? (
        <a href={item.url} target="_blank" rel="noreferrer noopener">
          {item.title}
        </a>
      ) : (
        <span>{item.title}</span>
      )}
    </span>
  );
}

export default function NewsBulletin({ items = [] }) {
  const [live, setLive] = useState(items);

  useEffect(() => {
    setLive(items);
  }, [items]);

  if (!live.length) {
    return (
      <div className="bulletin" aria-label="News bulletin">
        <span className="bulletin-label">Bulletin</span>
        <span className="bulletin-empty">No scored headlines in the last fourteen days.</span>
      </div>
    );
  }

  // Two identical copies: the track slides by half its width, which lands
  // exactly on the start of the second copy. No gap, no jump.
  return (
    <div className="bulletin" aria-label="News bulletin">
      <span className="bulletin-label">Bulletin</span>
      <div className="bulletin-viewport">
        <div className="bulletin-track">
          {live.map((item) => <Item key={`a-${item.id}`} item={item} />)}
          {live.map((item) => <Item key={`b-${item.id}`} item={item} />)}
        </div>
      </div>
    </div>
  );
}
