// A drawn line, not a chart. No axes, no gridlines, no tooltips: the number
// beside it carries the value and the line carries only the shape. That is all
// a reader needs to answer "is this moving, and which way".
//
// `domain` matters more than it looks. Bounded scores (bias is [-1, 1]) should
// be drawn against their real range, not against whatever happens to be in the
// window: a pair pinned at +0.73 for five readings is a steady bullish lean, and
// a min/max scaled line would show that as a meaningless flat line at the top
// of nothing. Given a domain, a dashed zero baseline is drawn too, so the reader
// can see which side of neutral the name is sitting on.

export default function Sparkline({
  values = [],
  width = 116,
  height = 28,
  tone = null,
  domain = null,
  label = 'trend',
}) {
  const nums = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (nums.length < 2) return <span className="muted tick">no history</span>;

  const lo = domain ? Number(domain[0]) : Math.min(...nums);
  const hi = domain ? Number(domain[1]) : Math.max(...nums);
  const span = hi - lo || 1;
  const pad = 2;

  // Clamp rather than let an out-of-range point draw outside the box.
  const at = (value) => Math.max(0, Math.min(1, (Number(value) - lo) / span));
  const yFor = (value) => height - pad - at(value) * (height - pad * 2);

  const stepX = width / (nums.length - 1);
  const points = nums.map((value, index) => [index * stepX, yFor(value)]);

  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  // With a signed domain, fill toward the zero line rather than the floor, so the
  // shaded area reads as distance from neutral instead of as a solid block.
  const hasZero = Boolean(domain) && lo < 0 && hi > 0;
  const baseline = hasZero ? yFor(0) : height;
  const area = `${line} L${width},${baseline.toFixed(1)} L0,${baseline.toFixed(1)} Z`;

  const first = nums[0];
  const last = nums[nums.length - 1];
  const direction = tone || (last > first ? 'up' : last < first ? 'down' : 'flat');

  return (
    <svg
      className={`spark ${direction}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}: ${direction} across ${nums.length} readings, latest ${last}`}
      preserveAspectRatio="none"
    >
      {hasZero ? (
        <line className="axis" x1="0" y1={baseline.toFixed(1)} x2={width} y2={baseline.toFixed(1)} />
      ) : null}
      <path className="fill" d={area} />
      <path className="line" d={line} />
    </svg>
  );
}
