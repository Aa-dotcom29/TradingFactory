import {
  directionTone, istStamp, num, outcomeTone, pct, resultLabel, resultTone, timeAgo,
} from '@/lib/format';

// Slice 7 output: the only panel that reports what actually happened. Everything else on this
// dashboard describes what the engine proposes; this is the settled record, and it is also what
// the risk gate's loss controls read before approving anything else.
//
// The scorecard is deliberately blunt. Expectancy is shown as "-" until there is both a win and a
// loss behind it, because a ratio off two trades is a coincidence with a decimal point.

function Score({ k, v, tone, u, title }) {
  return (
    <div className="stat" title={title}>
      <div className="k">{k}</div>
      <div className={`v${tone ? ` tone-${tone}` : ''}`}>
        {v}
        {u ? <span className="u">{u}</span> : null}
      </div>
    </div>
  );
}

function band(signal) {
  const parts = [];
  if (signal.entry != null) parts.push(`entry ${num(signal.entry, 2)}`);
  if (signal.stop != null) parts.push(`stop ${num(signal.stop, 2)}`);
  if (signal.target != null) parts.push(`target ${num(signal.target, 2)}`);
  return parts.join('  /  ') || 'no levels recorded';
}

function Scorecard({ stats }) {
  const rateTone = stats.winRatePct == null ? null : (stats.winRatePct >= 50 ? 'up' : 'down');
  const expTone = stats.expectancyPct == null ? null : (stats.expectancyPct >= 0 ? 'up' : 'down');
  const avgTone = stats.avgPnlPct == null ? null : (stats.avgPnlPct >= 0 ? 'up' : 'down');

  return (
    <div className="stat-row">
      <Score k="Closed trades" v={stats.total} title="Positions the evaluator has settled inside the 90-day window" />
      <Score k="Wins / losses" v={`${stats.wins} / ${stats.losses}`} />
      <Score
        k="Win rate"
        v={stats.winRatePct == null ? '-' : pct(stats.winRatePct, 1)}
        tone={rateTone}
      />
      <Score k="Avg per trade" v={stats.avgPnlPct == null ? '-' : pct(stats.avgPnlPct, 2)} tone={avgTone} />
      <Score
        k="Expectancy"
        v={stats.expectancyPct == null ? '-' : pct(stats.expectancyPct, 2)}
        tone={expTone}
        title="Average result per trade once the win rate is taken into account. Shown only once there is both a win and a loss to learn from."
      />
      <Score k="Best excursion" v={stats.avgMfePct == null ? '-' : pct(stats.avgMfePct, 2)} u="avg" />
      <Score k="Worst excursion" v={stats.avgMaePct == null ? '-' : pct(stats.avgMaePct, 2)} u="avg" />
      <Score k="Exits" v={`${stats.targets}/${stats.stops}/${stats.times}`} u="t/s/w" title="Target hits / stop hits / window ended" />
    </div>
  );
}

export default function Outcomes({ stats, closed = [], open = [], showHorizon = false }) {
  return (
    <div className="stack">
      <Scorecard stats={stats} />

      {closed.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Position</th>
                {showHorizon ? <th>Horizon</th> : null}
                <th>Levels</th>
                <th>Exit</th>
                <th>Entry to exit</th>
                <th>P&amp;L</th>
                <th>Excursion</th>
                <th>Held</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((row) => {
                const ambiguous = row.payload && row.payload.ambiguous;
                return (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.symbol}</strong>{' '}
                      <span className={`pill ${directionTone(row.direction)}`}>{row.direction}</span>
                      <div className="small muted">
                        {(row.snapshot && row.snapshot.mode) === 'live' ? 'delivered' : 'shadow'}
                      </div>
                    </td>
                    {showHorizon ? (
                      <td><span className="pill muted">{row.horizon}</span></td>
                    ) : null}
                    <td className="small mono muted">
                      {num(row.entry, 2)} / {num(row.stop, 2)} / {num(row.target, 2)}
                    </td>
                    <td>
                      <span className={`pill ${resultTone(row.result)}`}>{resultLabel(row.result)}</span>
                      {ambiguous ? (
                        <div className="small tone-warn" title="One price bar reached both levels, so the worse outcome was assumed.">
                          ambiguous bar
                        </div>
                      ) : null}
                    </td>
                    <td className="mono">
                      {num(row.entry, 2)} <span className="muted">&rarr;</span> {num(row.exit, 2)}
                    </td>
                    <td className={`mono tone-${outcomeTone(row.pnl_pct)}`}>
                      <strong>{pct(row.pnl_pct, 2)}</strong>
                    </td>
                    <td className="small mono muted">
                      best {pct(row.mfe_pct, 1)} / worst {pct(row.mae_pct, 1)}
                    </td>
                    <td className="small muted">
                      {row.bars_held ?? 0} reading{row.bars_held === 1 ? '' : 's'}
                      {row.payload && row.payload.heldMinutes != null ? (
                        <div>{Math.round(row.payload.heldMinutes / 60)}h after publication</div>
                      ) : null}
                    </td>
                    <td className="small muted">{istStamp(row.evaluated_at)} IST</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <strong>No closed trades yet</strong>
          A published signal becomes an outcome when it reaches its target, hits its stop, or its
          horizon&apos;s holding window runs out. Until then it is still open, and the risk gate&apos;s
          loss controls have nothing to read &mdash; which is why they report SKIPPED rather than a
          clean record.
        </div>
      )}

      {open.length ? (
        <>
          <div className="hr" />
          <p className="hint" style={{ margin: 0 }}>
            Still open &mdash; published and not yet settled. A position is only closed when its
            price path reaches a level, so one that cannot be priced is held rather than guessed at.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  {showHorizon ? <th>Horizon</th> : null}
                  <th>Levels</th>
                  <th>Status</th>
                  <th>Published</th>
                </tr>
              </thead>
              <tbody>
                {open.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.symbol}</strong>{' '}
                      <span className={`pill ${directionTone(row.direction)}`}>{row.direction}</span>
                      <div className="small muted">
                        {(row.snapshot && row.snapshot.mode) === 'live' ? 'delivered' : 'shadow'}
                      </div>
                    </td>
                    {showHorizon ? (
                      <td><span className="pill muted">{row.horizon}</span></td>
                    ) : null}
                    <td className="small mono muted">{band(row)}</td>
                    <td>
                      {row.option_plan ? (
                        <span
                          className="pill warn"
                          title="The plan's levels are option premiums, but only underlying quotes are recorded. Scoring it on spot would produce a confident, meaningless number."
                        >
                          awaiting price source
                        </span>
                      ) : (
                        <span className="pill muted">open</span>
                      )}
                    </td>
                    <td className="small muted">
                      {timeAgo(row.published_at)}
                      <div>{istStamp(row.published_at)} IST</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
