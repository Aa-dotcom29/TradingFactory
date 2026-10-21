import { compact, istStamp, num, timeAgo } from '@/lib/format';
import { depthImbalanceSeries, normaliseDepth, tapeRead } from '@/lib/tape';
import Sparkline from '@/components/Sparkline';

function LadderRow({ row, side, maxQty }) {
  const width = maxQty > 0 ? Math.max(2, Math.min(100, (row.quantity / maxQty) * 100)) : 2;
  return (
    <div className={`book-row ${side}`}>
      <span className="book-price mono">{num(row.price, 2)}</span>
      <span className="book-size">
        <span className="book-bar" style={{ width: `${width}%` }} />
        <span className="book-qty mono">{compact(row.quantity)}</span>
      </span>
      <span className="book-orders mono">{row.orders === null || Number.isNaN(row.orders) ? '-' : num(row.orders, 0)}</span>
    </div>
  );
}

export default function OrderBookPanel({ depth, history = [], title = 'Order book' }) {
  const book = normaliseDepth(depth);
  if (!book) {
    return (
      <section className="card">
        <h2>{title}</h2>
        <div className="empty">
          <strong>No book snapshot yet</strong>
          The tape worker stores a broker depth snapshot when it receives one. Five levels are
          available for F&amp;O; NSE cash can provide twenty. The exchange&apos;s full anonymous book
          is not published to retail feeds.
        </div>
      </section>
    );
  }

  const maxQty = Math.max(
    1,
    ...book.bids.map((row) => row.quantity),
    ...book.asks.map((row) => row.quantity),
  );
  const series = depthImbalanceSeries(history);
  const read = tapeRead({ imbalance: book.imbalance, delta: 0 });
  const bidShare = book.bidQty + book.askQty ? book.bidQty / (book.bidQty + book.askQty) : null;

  return (
    <section className="card">
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h2>{title}</h2>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            {book.levels} level(s) - {book.capturedAt ? `${istStamp(book.capturedAt)} IST (${timeAgo(book.capturedAt)})` : 'time unavailable'}
          </p>
        </div>
        <span className="pill muted">{read}</span>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 12 }}>
        <div className="stat">
          <div className="k">Best bid</div>
          <div className="v tone-up">{num(book.bestBid, 2)}</div>
        </div>
        <div className="stat">
          <div className="k">Best ask</div>
          <div className="v tone-down">{num(book.bestAsk, 2)}</div>
        </div>
        <div className="stat">
          <div className="k">Spread</div>
          <div className="v">{num(book.spread, 2)}</div>
        </div>
        <div className="stat">
          <div className="k">Mid</div>
          <div className="v">{num(book.mid, 2)}</div>
        </div>
      </div>

      <div className="book-imbalance" style={{ marginTop: 12 }} aria-label="Bid and ask quantity share">
        <span className="bid" style={{ width: `${bidShare === null ? 50 : bidShare * 100}%` }} />
        <span className="ask" style={{ width: `${bidShare === null ? 50 : (1 - bidShare) * 100}%` }} />
      </div>
      <div className="row-between small muted" style={{ marginTop: 4 }}>
        <span>Bid qty {compact(book.bidQty)}</span>
        <span>Ask qty {compact(book.askQty)}</span>
      </div>

      <div className="book-ladder" style={{ marginTop: 12 }}>
        <div className="book-head">
          <span>Price</span><span>Size</span><span>Orders</span>
        </div>
        {book.asks.slice().reverse().map((row, index) => (
          <LadderRow key={`ask-${row.price}-${index}`} row={row} side="ask" maxQty={maxQty} />
        ))}
        <div className="book-spread">
          <span className="mono">{num(book.bestBid, 2)}</span>
          <span className="muted small">spread {num(book.spread, 2)}</span>
          <span className="mono">{num(book.bestAsk, 2)}</span>
        </div>
        {book.bids.map((row, index) => (
          <LadderRow key={`bid-${row.price}-${index}`} row={row} side="bid" maxQty={maxQty} />
        ))}
      </div>

      {series.length > 1 ? (
        <>
          <div className="hr" />
          <div className="row-between">
            <div className="k">Book imbalance path</div>
            <span className="small muted">last {series.length} snapshots</span>
          </div>
          <Sparkline values={series} domain={[-1, 1]} tone={book.imbalance >= 0 ? 'up' : 'down'} label="book imbalance" />
          <div className="small muted" style={{ marginTop: 4 }}>
            +1 is all bid size, -1 is all ask size. The path is a snapshot series, not a forecast.
          </div>
        </>
      ) : null}

      <p className="hint" style={{ marginBottom: 0 }}>
        This is broker depth, not the exchange&apos;s full anonymous order book. F&amp;O is five levels;
        NSE cash can stream twenty. Execution remains manual.
      </p>
    </section>
  );
}
