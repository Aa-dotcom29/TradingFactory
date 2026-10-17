'use client';

import { useEffect, useState } from 'react';

// The rail's live figures. Rendered on the client because a clock that only
// moves when the page is reloaded is worse than no clock, and the session state
// has to be read against the exchange's own timezone, not the viewer's.

const OPEN_MIN = 9 * 60 + 15;   // NSE equity session, 09:15 IST
const CLOSE_MIN = 15 * 60 + 30; // through 15:30 IST

function readIst(date) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  return parts;
}

function sessionState(now) {
  if (!now) return { open: false, label: 'session' };
  const p = readIst(now);
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const weekend = p.weekday === 'Sat' || p.weekday === 'Sun';

  if (weekend) return { open: false, label: 'weekend' };
  if (minutes < OPEN_MIN) return { open: false, label: 'pre-open' };
  if (minutes > CLOSE_MIN) return { open: false, label: 'after hours' };
  return { open: true, label: 'market open' };
}

export default function RailStatus({ mode = 'shadow' }) {
  const [now, setNow] = useState(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const state = sessionState(now);
  const clock = now ? (() => {
    const p = readIst(now);
    return `${p.hour}:${p.minute}:${p.second}`;
  })() : '--:--:--';

  const shadow = String(mode).toLowerCase() !== 'live';
  const mixed = String(mode).toLowerCase() === 'mixed';

  return (
    <>
      <span className={`chip ${state.open ? 'live' : 'shut'}`} title="NSE equity session, 09:15-15:30 IST, weekdays">
        <i className="lamp" />
        {state.label}
      </span>

      <span className="chip" title="Indian Standard Time">
        ist <span className="val" suppressHydrationWarning>{clock}</span>
      </span>

      <span
        className={`chip ${shadow ? 'caution' : 'live'}`}
        title={mixed
          ? 'Some horizons are delivering; the rest only write the ledger'
          : shadow
            ? 'Signals are written and logged but nothing is delivered'
            : 'Signals are delivered to the household channel'}
      >
        <i className="lamp" />
        {mixed ? 'mixed delivery' : (shadow ? 'shadow delivery' : 'live delivery')}
      </span>
    </>
  );
}
