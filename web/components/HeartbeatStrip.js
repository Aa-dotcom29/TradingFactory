'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

// A ten-dot heartbeat for the whole harness, sitting in the rail where it is
// always visible. Each dot is one worker, coloured by the worst of that
// worker's own sources_health rows. The dots are fetched again on a timer so a
// stopped harness goes red in the browser without a page reload.
//
// The server layout passes a first snapshot, so the strip is correct on the
// very first paint and the poll only has to keep it honest.

const REFRESH_MS = 20000;

function shortAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function HeartbeatStrip({ initial = null }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;

    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) throw new Error(`health ${res.status}`);
        const data = await res.json();
        if (stopped) return;
        if (data && Array.isArray(data.workers)) {
          setSnapshot(data);
          setFailed(false);
        }
      } catch {
        if (!stopped) setFailed(true);
      }
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const workers = (snapshot && snapshot.workers) || [];
  const totals = (snapshot && snapshot.totals) || { up: 0, warn: 0, down: 0, muted: 0 };
  const total = workers.length || 10;
  const label = workers.length
    ? `Pipeline liveness: ${totals.up} of ${total} workers up, ${totals.warn} warning, ${totals.down} down, ${totals.muted} idle or unreported`
    : 'Pipeline liveness has not reported yet';

  return (
    <Link
      href="/dashboard/arcade"
      className={`heartbeat${failed ? ' failed' : ''}`}
      aria-label={label}
      title={label}
    >
      <span className="hb-leds" aria-hidden="true">
        {workers.map((worker) => (
          <span
            key={worker.id}
            className={`hb-led ${worker.tone || 'muted'} ${worker.liveness || ''}`}
            title={`${worker.id} ${worker.name}: ${worker.status}${
              worker.ageMs == null ? '' : `, last beat ${shortAge(worker.ageMs)} ago`
            } - ${worker.detail}`}
          />
        ))}
      </span>
      <span className="hb-text" aria-hidden="true">
        <strong>{totals.up}/{total} up</strong>
        {totals.warn ? <span className="warn">{totals.warn} warn</span> : null}
        {totals.down ? <span className="down">{totals.down} down</span> : null}
        {failed ? <span className="warn">check failed</span> : null}
      </span>
    </Link>
  );
}
