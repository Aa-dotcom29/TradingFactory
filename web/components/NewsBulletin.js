'use client';

import { useEffect, useMemo, useState } from 'react';
import RelativeTime from '@/components/RelativeTime';

// The news bulletin: a broadcast crawl under the rail.
//
// It moves on its own, the way a television news line does, and it keeps a
// constant speed: a long list does not crawl faster and a short one does not
// crawl slower. The duration is derived from the number of headlines, not
// fixed for the page.
//
// The track holds the list twice and slides exactly one copy, so the loop is
// seamless - there is no gap and no jump.
//
// A hold control is always available, because a crawl you cannot stop is a
// crawl you cannot read. It is also the honest answer to a reader who has
// asked the system to stop moving: under prefers-reduced-motion the crawl
// starts paused, and the control says so.
//
// Everything shown is a real scored headline from the database. There is no
// filler and no invented urgency: a headline with no severity reads as plain
// text, and the timestamp is the exchange time, not the ingest time.

const SEVERITIES = ['CRITICAL', 'HIGH'];

// How long one headline stays on screen, in seconds. A news line gives a
// story a beat before the next one arrives.
const SECONDS_PER_ITEM = 4.2;

function Item({ item }) {
  const severity = String(item.severity || '').toUpperCase();
  const flagged = SEVERITIES.includes(severity);
  return (
    <span className="bulletin-item">
      <RelativeTime at={item.published_at} className="bulletin-time" />
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
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setLive(items);
  }, [items]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      const on = mq.matches;
      setReduced(on);
      // A reader who has asked for less motion gets a still strip, held in
      // place, with the control available to start it.
      setPaused(on);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // The crawl travels one full copy of the list. Two copies sit in the track,
  // so the distance is half the track width and the seam lands exactly.
  const duration = useMemo(() => {
    const count = live.length || 1;
    return Math.max(18, Math.round(count * SECONDS_PER_ITEM));
  }, [live.length]);

  if (!live.length) {
    return (
      <div className="bulletin" aria-label="News bulletin">
        <span className="bulletin-empty">No scored headlines in the last fourteen days.</span>
      </div>
    );
  }

  return (
    <div className={`bulletin${paused ? ' is-paused' : ''}`} aria-label="News bulletin">
      <div className="bulletin-viewport">
        <div
          className="bulletin-track"
          style={{ animationDuration: `${duration}s` }}
        >
          {live.map((item) => <Item key={`a-${item.id}`} item={item} />)}
          {live.map((item) => <Item key={`b-${item.id}`} item={item} />)}
        </div>
      </div>
      <button
        type="button"
        className="bulletin-control"
        onClick={() => setPaused((value) => !value)}
        aria-pressed={paused}
        aria-label={paused ? 'Resume the news crawl' : 'Hold the news crawl'}
        title={paused ? 'Resume the crawl' : 'Hold the crawl'}
      >
        <span className="glyph" aria-hidden="true">{paused ? '>' : '||'}</span>
        {paused ? (reduced ? 'Held' : 'Hold') : 'Live'}
      </button>
    </div>
  );
}
