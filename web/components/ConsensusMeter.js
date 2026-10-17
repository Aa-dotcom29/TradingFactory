// Where the house's read actually sits: how many tracked names lean bullish,
// how many lean bearish, and how many are still undecided. A single number
// would hide that last group, which is usually the honest majority.

export default function ConsensusMeter({ counts = {}, caption = null }) {
  const up = counts.BULLISH || 0;
  const down = counts.BEARISH || 0;
  const neutral = counts.NEUTRAL || 0;
  const total = up + down + neutral;

  if (!total) {
    return <div className="empty">No verdicts stored yet. The bias meter runs once quotes and flow arrive.</div>;
  }

  const pct = (n) => `${((n / total) * 100).toFixed(2)}%`;

  return (
    <div>
      <div className="meter" style={{ height: 10 }} role="img" aria-label={`${up} bullish, ${down} bearish, ${neutral} neutral`}>
        <div className="seg down" style={{ width: pct(down) }} />
        <div className="seg mute" style={{ width: pct(neutral) }} />
        <div className="seg up" style={{ width: pct(up) }} />
      </div>

      <div className="meter-legend">
        <span className="tone-down">bearish <b>{down}</b></span>
        <span className="muted">undecided <b>{neutral}</b></span>
        <span className="tone-up">bullish <b>{up}</b></span>
        <span className="muted" style={{ marginLeft: 'auto' }}>{total} tracked pairs</span>
      </div>

      {caption ? <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>{caption}</p> : null}
    </div>
  );
}
