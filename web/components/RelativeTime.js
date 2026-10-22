'use client';

import { useEffect, useState } from 'react';
import { istStamp, timeAgo } from '@/lib/format';

// A relative age that is safe to hydrate.
//
// The server renders "7m ago" at its own moment and the browser hydrates a
// moment later, so the two can disagree - "59m ago" against "1h ago" - and
// React tears the tree down. The first paint is therefore the absolute
// exchange time, which is identical on both sides, and the relative form
// arrives once the component is live.

export default function RelativeTime({ at, className = 'tick' }) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    setLive(true);
  }, []);

  if (!at) return <span className="muted">-</span>;

  return (
    <span className={className} title={istStamp(at)}>
      {live ? timeAgo(at) : istStamp(at)}
    </span>
  );
}
