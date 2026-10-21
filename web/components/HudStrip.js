'use client';

import { useEffect, useState } from 'react';

// The HUD strip.
//
// A thin instrument bar that sits above the Agents Workspace board: an
// instance tag, the live exchange clock, and a running read-out. It is the
// detail that makes the board feel like a machine you are looking into rather
// than a diagram of one.
//
// The clock is real: it is the current IST time, ticking. The instance tag is
// real too: it is a per-tab counter, so two tabs are distinguishable, and it
// is labelled CLIENT so it is never mistaken for a server identifier.

const IST = 'Asia/Kolkata';

function readIstParts(date) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: 'short',
  });
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  return parts;
}

function clientTag() {
  try {
    const key = 'tf-client-tag';
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const bytes = new Uint8Array(3);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    const tag = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    window.sessionStorage.setItem(key, tag);
    return tag;
  } catch {
    return '--------';
  }
}

export default function HudStrip({ tone = 'up', label = 'AGENTS', metrics = [] }) {
  const [clock, setClock] = useState(null);
  const [tag, setTag] = useState('--------');

  useEffect(() => {
    setTag(clientTag());
    const tick = () => setClock(readIstParts(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const stamp = clock
    ? `${clock.weekday} ${clock.day} ${clock.month} ${clock.hour}:${clock.minute}:${clock.second} IST`
    : '--:--:-- IST';

  return (
    <div className={`hud-strip tone-${tone}`} role="status" aria-label="Instrument status strip">
      <span className="hud-cell hud-id">
        <span className="hud-led" aria-hidden="true" />
        {label} // {tag}
      </span>
      <span className="hud-cell hud-clock mono">{stamp}</span>
      {metrics.map((metric) => (
        <span className="hud-cell mono" key={metric.k}>
          <span className="hud-key">{metric.k}</span>
          {metric.v}
        </span>
      ))}
      <span className="hud-cell hud-sweep" aria-hidden="true" />
    </div>
  );
}
