'use client';

import { useMemo, useRef, useState } from 'react';
import { num, istStamp } from '@/lib/format';
import { nearestSampleIndex, sparklinePoints } from '@/lib/trade';

// A price path for the trade workspace. The existing Sparkline component is a
// bounded-score chart with a zero axis; this one is deliberately simpler because
// a quote series has no fixed domain.
//
// It is interactive: moving the pointer over the line snaps a crosshair to the
// nearest stored sample and prints that sample's value and timestamp. The path
// itself is still only the shape - the label carries the number, exactly as the
// static sparkline does - so hovering adds precision without inventing it.

export default function PriceSparkline({ series = [], width = 320, height = 64, tone = 'accent' }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  const samples = useMemo(() => (Array.isArray(series) ? series : [])
    .map((row) => ({ at: row && row.at, ltp: Number(row && row.ltp) }))
    .filter((row) => Number.isFinite(row.ltp)), [series]);

  const points = sparklinePoints(series, width, height);
  if (!points || samples.length < 2) {
    return <div className="small muted">Not enough samples to draw a path yet.</div>;
  }

  const count = samples.length;
  const low = Math.min(...samples.map((row) => row.ltp));
  const high = Math.max(...samples.map((row) => row.ltp));
  const span = high - low || 1;
  const xFor = (index) => (index / (count - 1)) * width;
  const yFor = (value) => height - ((value - low) / span) * height;

  const onMove = (event) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    setHover(nearestSampleIndex(ratio, count));
  };

  const active = hover == null ? null : samples[hover];
  const activeX = hover == null ? null : xFor(hover);
  const activeY = active ? yFor(active.ltp) : null;

  return (
    <div className="price-chart">
      <svg
        ref={svgRef}
        className={`sparkline ${tone}`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Recent price path, ${count} samples, low ${num(low, 2)}, high ${num(high, 2)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <polyline points={points} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {active ? (
          <>
            <line
              className="pc-cross"
              x1={activeX}
              y1={0}
              x2={activeX}
              y2={height}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <line
              className="pc-cross"
              x1={0}
              y1={activeY}
              x2={width}
              y2={activeY}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
      </svg>

      <div className="pc-foot">
        {active ? (
          <>
            <span className="mono pc-value">{num(active.ltp, 2)}</span>
            <span className="tick">{active.at ? `${istStamp(active.at)} IST` : 'sample'}</span>
            <span className="tick">{`${hover + 1}/${count}`}</span>
          </>
        ) : (
          <>
            <span className="tick">low {num(low, 2)}</span>
            <span className="tick">high {num(high, 2)}</span>
            <span className="tick">hover the line for a sample</span>
          </>
        )}
      </div>
    </div>
  );
}
