'use client';

import { num, signed, timeAgo } from '@/lib/format';

// Higher-timeframe / lower-timeframe agreement, for the index names only.
//
// The panel answers one question: is the short-term structure pointing the
// same way as the larger one? A 5-minute bar that disagrees with the 15-minute
// bar is a warning, not a signal, and it is shown as a warning.
//
// Everything is measured from stored quotes. If there are not enough bars the
// read is UNAVAILABLE with the reason on it, because a made-up direction is
// worse than an absent one.

function ageLabel(ageMs) {
  if (ageMs == null) return 'no quotes stored';
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 1) return 'under a minute old';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.round(hours / 24)}d old`;
}

// A read taken from a closed session is still the most recent structure
// there is, but it must never be dressed up as a live one.
function freshnessNote(ageMs) {
  if (ageMs == null) return 'no stored quotes';
  const minutes = Math.round(ageMs / 60000);
  if (minutes > 30) return `from the last session (${ageLabel(ageMs)})`;
  return ageLabel(ageMs);
}

function Lane({ label, minutes, bias }) {
  const tone = bias.status !== 'OK'
    ? 'muted'
    : bias.direction === 'UP' ? 'up' : bias.direction === 'DOWN' ? 'down' : 'muted';
  // The direction marker is drawn by CSS, not by a glyph character, so the
  // source stays strict ASCII.
  const shape = bias.status !== 'OK' ? 'unknown' : bias.direction;
  return (
    <div className="tf-lane">
      <span className="tf-lane-label">{label}</span>
      <span className={`tf-lane-arrow ${tone} ${shape}`} aria-hidden="true" />
      <span className="tf-lane-value mono">
        {bias.status === 'OK' ? signed(bias.changePct, 2) : 'n/a'}
      </span>
      <span className="tf-lane-bars tick">{bias.bars} bars</span>
    </div>
  );
}

export default function TimeframeAlignment({ read, symbol, compact = false }) {
  if (!read) {
    return (
      <div className="tf-align tf-empty">
        <span className="muted small">
          {symbol ? `No stored quotes for ${symbol} - 5m/15m bias is unavailable.` : 'No stored quotes - 5m/15m bias is unavailable.'}
        </span>
      </div>
    );
  }

  const { ltf, htf, alignment, ageMs } = read;
  const stale = ageMs != null && ageMs > 30 * 60 * 1000;

  return (
    <div className={`tf-align${compact ? ' compact' : ''}`}>
      <div className="tf-head">
        <span className={`tf-verdict ${alignment.tone}`}>{alignment.label}</span>
        <span className="tick">
          {ltf.minutes}m vs {htf.minutes}m bias - {freshnessNote(ageMs)}
        </span>
      </div>
      <div className="tf-lanes">
        <Lane label={`${ltf.minutes}m`} minutes={ltf.minutes} bias={ltf} />
        <Lane label={`${htf.minutes}m`} minutes={htf.minutes} bias={htf} />
      </div>
      {alignment.label === 'DIVERGED' ? (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          The short and long timeframe disagree. Treat a move against the 15m
          read as a warning, not a confirmation.
        </p>
      ) : null}
      {alignment.label === 'UNAVAILABLE' ? (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {ltf.reason || htf.reason || 'Not enough stored bars to measure a direction.'}
        </p>
      ) : null}
    </div>
  );
}

// A one-line badge for use inside a signal card.
export function TimeframeBadge({ read }) {
  if (!read) return null;
  const { ltf, htf, alignment, ageMs } = read;
  const stale = ageMs != null && ageMs > 30 * 60 * 1000;
  if (alignment.label === 'UNAVAILABLE') {
    return (
      <span className="tf-badge muted" title="Not enough stored quotes to measure 5m and 15m bias.">
        5m/15m n/a
      </span>
    );
  }
  const title = `5m ${ltf.direction} ${ltf.changePct == null ? '' : signed(ltf.changePct, 2)}% | 15m ${htf.direction} ${htf.changePct == null ? '' : signed(htf.changePct, 2)}% | ${freshnessNote(ageMs)}`;
  return (
    <span className={`tf-badge ${alignment.tone}${stale ? ' stale' : ''}`} title={title}>
      <span className="mono">5m</span>
      <span className={`tf-badge-arrow ${ltf.direction.toLowerCase()}`} aria-hidden="true" />
      <span className="mono">15m</span>
      <span className={`tf-badge-arrow ${htf.direction.toLowerCase()}`} aria-hidden="true" />
      <span className="tf-badge-label">{alignment.label}</span>
    </span>
  );
}
