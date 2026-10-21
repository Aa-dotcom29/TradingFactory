'use client';

import { istStamp, num, signed, directionTone, scoreTone } from '@/lib/format';
import Provenance from '@/components/Provenance';
import Sparkline from '@/components/Sparkline';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// Slice 3 output: the bias meter's verdict per symbol. Score is [-1, 1] and confidence is how
// much evidence actually backed it, so a name can lean bullish at 5% confidence without ever
// being presented as a call. Everything shown is read back from stored verdicts.
//
// The panel is intentionally concise: symbol, bias, score, confidence, and a micro trend.
// The full component breakdown, evidence items, and history live on the detail page.
//
// The whole row is a click target, but the anchor sits inside the symbol cell
// rather than wrapping the <tr>. A link wrapped around a table row is invalid
// HTML, and browsers hoist the anchor out of the table, which would break the
// row entirely. The anchor keeps keyboard access, middle-click and
// open-in-new-tab working; the click handler covers the rest of the row.

function BiasRow({ row, showHorizon, onOpen }) {
  const href = `/dashboard/bias/${(row.horizon || 'INTRADAY').toLowerCase()}/${row.symbol}`;
  return (
    <tr
      className="bias-row"
      onClick={(event) => {
        // The anchor handles its own activation; do not navigate twice.
        if (event.target.closest('a')) return;
        onOpen(href);
      }}
    >
      <td>
        <Link href={href} className="bias-link">{row.symbol}</Link>
        <div className="small muted">{istStamp(row.as_of)} IST</div>
      </td>
      {showHorizon ? (
        <td>
          <span className="pill muted">{row.horizon}</span>
        </td>
      ) : null}
      <td>
        <span className={`pill ${directionTone(row.direction)}`}>{row.direction}</span>{' '}
        <Provenance value={row.provenance} />
      </td>
      <td className={`num mono ${scoreTone(row.score)}`}>{signed(row.score, 3)}</td>
      <td className="num mono">{num(Number(row.confidence) * 100, 0)}%</td>
      <td className="num">
        <span
          className="trend-cell"
          title={`${row.symbol} ${row.horizon || ''}: score across the last ${row.history?.length || 0} stored verdicts, oldest first`}
        >
          <Sparkline values={row.history} domain={[-1, 1]} width={92} height={24} label={`${row.symbol} score path`} />
        </span>
      </td>
    </tr>
  );
}

export default function BiasPanel({ rows = [], showHorizon = false }) {
  const router = useRouter();

  if (!rows.length) {
    return (
      <div className="empty">
        <strong>No bias verdicts yet</strong>
        The bias worker scores each tracked symbol once it has flow or news evidence to work
        with. Verdicts are withheld rather than guessed when the evidence is thin.
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className="bias-table">
        <thead>
          <tr>
            <th>Symbol</th>
            {showHorizon ? <th>Horizon</th> : null}
            <th>Bias</th>
            <th className="num">Score</th>
            <th className="num">Conf</th>
            <th className="num">Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <BiasRow
              key={`${row.horizon || 'INTRADAY'}-${row.symbol}`}
              row={row}
              showHorizon={showHorizon}
              onOpen={(href) => router.push(href)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
