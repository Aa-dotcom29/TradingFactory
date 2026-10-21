import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { getUserTrades } from '@/lib/queries';
import {
  directionTone, num, istStamp, tradeOutcomeTone, tradeStatusTone,
} from '@/lib/format';
import StatusBanner from '@/components/StatusBanner';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Trades - Trading Factory' };

export default async function TradesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const email = String(user.email || '').trim().toLowerCase();
  const trades = await getUserTrades(email, 50);
  const open = trades.filter((trade) => String(trade.status).toUpperCase() === 'OPEN').length;
  const closed = trades.length - open;

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>Trade journal</h1>
          <p className="muted small" style={{ margin: '5px 0 0' }}>
            Every published signal you marked as entered. The live workspace is one click away, and
            your outcome mark is kept separate from the evaluator.
          </p>
        </div>
        <span className="pill accent">{trades.length} total</span>
      </div>

      <StatusBanner
        tone={open ? 'up' : 'sig'}
        headline={open ? `${open} open trade${open === 1 ? '' : 's'}` : 'No open trades'}
        facts={[
          { k: 'total', v: trades.length },
          { k: 'open', v: open },
          { k: 'closed', v: closed },
        ]}
        note="Execution is manual. This journal records what you did, not what the harness would have done."
      />

      {trades.length ? (
        <div className="stack">
          {trades.map((trade) => (
            <section className="card" key={trade.id} style={{ boxShadow: 'none' }}>
              <div className="row-between">
                <div>
                  <strong style={{ fontSize: 16 }}>{trade.symbol}</strong>{' '}
                  {trade.instrument ? <span className="muted">{trade.instrument}</span> : null}
                  <div className="small muted">
                    {trade.horizon} - entered {istStamp(trade.entered_at)} IST
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className={`pill ${directionTone(trade.direction)}`}>{trade.direction}</span>
                  <span className={`pill ${tradeStatusTone(trade.status)}`}>{trade.status}</span>
                  {trade.outcome ? (
                    <span className={`pill ${tradeOutcomeTone(trade.outcome)}`}>{trade.outcome}</span>
                  ) : null}
                </div>
              </div>

              <div className="stat-row" style={{ marginTop: 12, gridTemplateColumns: 'repeat(5, 1fr)' }}>
                <div className="stat">
                  <div className="k">Plan entry</div>
                  <div className="v mono">{num(trade.plan_entry, 2)}</div>
                </div>
                <div className="stat">
                  <div className="k">Your entry</div>
                  <div className="v mono">{num(trade.entry_price, 2)}</div>
                </div>
                <div className="stat">
                  <div className="k">Target</div>
                  <div className="v mono">{num(trade.target, 2)}</div>
                </div>
                <div className="stat">
                  <div className="k">Stop</div>
                  <div className="v mono">{num(trade.stop, 2)}</div>
                </div>
                <div className="stat">
                  <div className="k">Published</div>
                  <div className="v mono">{istStamp(trade.published_at)}</div>
                </div>
              </div>

              {trade.outcome_note ? (
                <p className="small muted" style={{ margin: '10px 0 0' }}>{trade.outcome_note}</p>
              ) : null}

              <div className="row-between" style={{ marginTop: 12 }}>
                <span className="small muted">
                  {trade.outcome_at ? `Marked ${istStamp(trade.outcome_at)} IST` : 'Outcome not marked yet.'}
                </span>
                <Link className="btn sm" href={`/dashboard/trade/${trade.id}`}>
                  Open workspace
                </Link>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="empty">
          <strong>No trades entered yet</strong>
          Open a horizon page, find a published signal, and press Trade entered. The focus workspace
          opens in a new tab and this journal keeps the link.
        </div>
      )}
    </div>
  );
}
