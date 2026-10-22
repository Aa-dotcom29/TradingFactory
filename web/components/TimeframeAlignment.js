'use client';

import { num, signed, timeAgo } from '@/lib/format';

// The timeframe alignment read.
//
// One question: is the short-term structure pointing the same way as the
// longer one? A 5-minute bar that disagrees with the 15-minute bar is a
// warning, not a signal.
//
// The chart is two bars from a common centre line, one per timeframe, each
// scaled by how far it moved. When they point the same way the read is
// ALIGNED; when they oppose, DIVERGED. A flat bar cannot confirm anything, so
// it reads FLAT.
//
// Everything is measured from stored quotes. If there are not enough bars the
// read is UNAVAILABLE with the reason on it, because a made-up direction is
// worse than an absent one.

const SEVERITIES = ['CRITICAL', 'HIGH'];

// The scale of the chart. A 0.35% move is a full bar; anything beyond that
// is clipped, because the point is the direction, not the magnitude.
const SCALE_PCT = 0.35;

function ageLabel(ageMs) {
  if (ageMs == null) return 'no quotes stored';
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 1) return 'under a minute old';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.round(hours / 24)}d old`;
}

function freshnessNote(ageMs) {
  if (ageMs == null) return 'no stored quotes';
  const minutes = Math.round(ageMs / 60000);
  if (minutes > 30) return `from the last session (${ageLabel(ageMs)})`;
  return ageLabel(ageMs);
}

function toneOf(direction, status) {
  if (status !== 'OK') return 'muted';
  if (direction === 'UP') return 'up';
  if (direction === 'DOWN') return 'down';
  return 'muted';
}

// One bar, drawn from the centre line outwards.
function Bar({ label, bias, y, height }) {
  const tone = toneOf(bias.direction, bias.status);
  const value = bias.status === 'OK' ? Number(bias.changePct) : 0;
  const ratio = Math.max(-1, Math.min(1, value / SCALE_PCT));
  const up = ratio >= 0;
  const barLength = Math.abs(ratio) * height;
  const centre = y + height / 2;

  return (
    <g>
      <text className="tf-chart-label" x="0" y={y + height / 2 + 4}>{label}</text>
      <line className="tf-chart-axis" x1="42" y1={centre} x2="46" y2={centre} />
      <rect
        className={`tf-chart-bar ${tone}`}
        x="46"
        y={up ? centre - barLength : centre}
        width="150"
        height={Math.max(barLength, 1.5)}
        rx="1.5"
      />
      <text className="tf-chart-value" x="204" y={centre + 4}>
        {bias.status === 'OK' ? `${signed(value, 2)}%` : 'n/a'}
      </text>
    </g>
  );
}

function AlignmentChart({ read }) {
  const height = 26;
  return (
    <svg className="tf-chart" viewBox="0 0 260 62" role="img" aria-label="5 minute and 15 minute bias bars">
      <line className="tf-chart-mid" x1="46" y1="31" x2="196" y2="31" />
      <Bar label="5m" bias={read.ltf} y={2} height={height} />
      <Bar label="15m" bias={read.htf} y={34} height={height} />
    </svg>
  );
}

export default function TimeframeAlignment({ read, symbol, compact = false }) {
  if (!read) {
    return (
      <div className="tf-align tf-empty">
        <span className="muted small">
          {symbol
            ? `No stored quotes for ${symbol} - 5m/15m bias is unavailable.`
            : 'No stored quotes - 5m/15m bias is unavailable.'}
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
          {ltf.minutes}m vs {htf.minutes}m - {freshnessNote(ageMs)}
        </span>
      </div>

      <AlignmentChart read={read} />

      {alignment.label === 'DIVERGED' ? (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          The short and long timeframe disagree. Treat a move against the 15m
          read as a warning, not a confirmation.
        </p>
      ) : null}
      {alignment.label === 'FLAT' ? (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          One of the two timeframes is flat, so neither confirms nor contradicts
          the other.
        </p>
      ) : null}
      {alignment.label === 'UNAVAILABLE' ? (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {ltf.reason || htf.reason || 'Not enough stored bars to measure a direction.'}
        </p>
      ) : null}
      {stale ? (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          This is the last session&apos;s structure, not a live read.
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
