import { compact, istStamp, num, signed, timeAgo } from '@/lib/format';
import { tapeRead } from '@/lib/tape';

const IST = 'Asia/Kolkata';

function barLabel(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function cellTone(cell) {
  if (!cell) return '';
  if (cell.delta > 0) return 'buy-heavy';
  if (cell.delta < 0) return 'sell-heavy';
  return '';
}

function Cell({ cell }) {
  if (!cell) return <span className="fp-empty">-</span>;
  return (
    <>
      <span className="fp-buy">{compact(cell.buy)}</span>
      <span className="fp-sep">x</span>
      <span className="fp-sell">{compact(cell.sell)}</span>
      {cell.unknown ? <span className="fp-unknown">+{compact(cell.unknown)}?</span> : null}
    </>
  );
}

export default function FootprintPanel({ analysis, title = 'Footprint', subtitle = '' }) {
  if (!analysis || !analysis.rows || !analysis.rows.length) {
    return (
      <section className="card">
        <h2>{title}</h2>
        <div className="empty">
          <strong>No tape prints yet</strong>
          The broker WebSocket has not stored a trade print for this name. The panel will fill
          in while the market is open; it does not invent volume from the daily quote.
        </div>
      </section>
    );
  }

  const { rows, bars, totals, bucket, largePrints } = analysis;
  const read = tapeRead({ delta: totals.delta, imbalance: analysis.imbalance });
  return (
    <section className="card">
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="hint" style={{ margin: '4px 0 0' }}>{subtitle}</p> : null}
        </div>
        <span className="pill accent">{read}</span>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 12 }}>
        <div className="stat">
          <div className="k">Tape delta</div>
          <div className={`v ${totals.delta >= 0 ? 'tone-up' : 'tone-down'}`}>{signed(totals.delta, 0)}</div>
        </div>
        <div className="stat">
          <div className="k">Buy volume</div>
          <div className="v tone-up">{compact(totals.buy)}</div>
        </div>
        <div className="stat">
          <div className="k">Sell volume</div>
          <div className="v tone-down">{compact(totals.sell)}</div>
        </div>
        <div className="stat">
          <div className="k">Prints</div>
          <div className="v">{num(totals.prints, 0)}</div>
        </div>
      </div>

      <div className="small muted" style={{ marginTop: 8 }}>
        {num(totals.volume, 0)} tape volume in {bars.length} minute bar(s), price bucket {num(bucket, 2)}.
        {totals.unknown ? ` ${compact(totals.unknown)} print volume could not be sided.` : ''}
        {analysis.latestAt ? ` Latest print ${timeAgo(analysis.latestAt)}.` : ''}
      </div>

      <div className="table-scroll" style={{ marginTop: 12 }}>
        <table className="footprint-table">
          <thead>
            <tr>
              <th>Price</th>
              {bars.map((bar) => <th key={bar.at} title={istStamp(bar.at)}>{barLabel(bar.at)}</th>)}
              <th>Total</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.price}>
                <th>{num(row.price, 2)}</th>
                {row.cells.map((cell, index) => {
                  const bar = bars[index];
                  const label = `${num(row.price, 2)} at ${bar ? barLabel(bar.at) : '-'}`;
                  const title = cell
                    ? `${label}: buy ${compact(cell.buy)} x sell ${compact(cell.sell)}${
                      cell.unknown ? ` + ${compact(cell.unknown)} unsided` : ''
                    }`
                    : `${label}: no prints`;
                  return (
                    <td
                      key={`${row.price}-${index}`}
                      className={`fp-cell ${cellTone(cell)}`.trim()}
                      title={title}
                    >
                      <Cell cell={cell} />
                    </td>
                  );
                })}
                <td className="mono">{compact(row.total)}</td>
                <td className={`mono ${row.delta >= 0 ? 'tone-up' : 'tone-down'}`}>{signed(row.delta, 0)}</td>
              </tr>
            ))}
            <tr className="fp-delta-row">
              <th>Delta</th>
              {bars.map((bar) => (
                <td key={`d-${bar.at}`} className={bar.delta >= 0 ? 'tone-up' : 'tone-down'}>
                  {signed(bar.delta, 0)}
                </td>
              ))}
              <td className={totals.delta >= 0 ? 'tone-up' : 'tone-down'}>{signed(totals.delta, 0)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="small muted" style={{ marginTop: 8 }}>
        Each cell is buy x sell volume at that price. Green tint means net buying, red net selling.
        Side is inferred from the print price versus the best bid/ask; it is not an exchange
        aggressor flag.
      </div>

      {largePrints && largePrints.length ? (
        <>
          <div className="hr" />
          <div className="k">Largest prints in the window</div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Time</th><th>Price</th><th>Volume</th><th>Side</th><th>Confidence</th></tr>
              </thead>
              <tbody>
                {largePrints.map((print, index) => (
                  <tr key={`${print.at}-${index}`}>
                    <td className="small muted">{barLabel(print.at)}</td>
                    <td className="mono">{num(print.price, 2)}</td>
                    <td className="mono">{compact(print.volume)}</td>
                    <td className={print.side === 'BUY' ? 'tone-up' : print.side === 'SELL' ? 'tone-down' : 'muted'}>
                      {print.side}
                    </td>
                    <td className="small muted">{print.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
