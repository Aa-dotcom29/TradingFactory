import { sparklinePoints } from '@/lib/trade';

// A price path for the trade workspace. The existing Sparkline component is a
// bounded-score chart with a zero axis; this one is deliberately simpler because
// a quote series has no fixed domain.
export default function PriceSparkline({ series = [], width = 320, height = 64, tone = 'accent' }) {
  const points = sparklinePoints(series, width, height);
  if (!points) {
    return <div className="small muted">Not enough samples to draw a path yet.</div>;
  }

  return (
    <svg
      className={`sparkline ${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Recent price path"
    >
      <polyline points={points} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
