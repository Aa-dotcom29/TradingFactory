import { istStamp, num, signed, directionTone, scoreTone } from '@/lib/format';
import Provenance from '@/components/Provenance';
import Sparkline from '@/components/Sparkline';

// Slice 3 output: the bias meter's verdict per symbol. Score is [-1, 1] and confidence is how
// much evidence actually backed it, so a name can lean bullish at 5% confidence without ever
// being presented as a call. Everything shown is read back from stored verdicts.

function componentPills(components) {
  if (!components || typeof components !== 'object') return <span className="muted small">-</span>;
  const entries = Object.entries(components);
  if (!entries.length) return <span className="muted small">-</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {entries.map(([key, component]) => {
        const available = component && component.available;
        const title = component && component.detail ? `${key}: ${component.detail}` : key;
        return (
          <span
            className={`pill ${available ? scoreTone(component.score) : 'muted'}`}
            key={key}
            title={title}
          >
            {key} {available ? signed(component.score, 2) : 'n/a'}
          </span>
        );
      })}
    </span>
  );
}

export default function BiasPanel({ rows = [], showHorizon = false }) {
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
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            {showHorizon ? <th>Horizon</th> : null}
            <th>Bias</th>
            <th className="num">Score</th>
            <th className="num">Confidence</th>
            <th className="num">Trend</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.horizon || 'INTRADAY'}-${row.symbol}`}>
              <td>
                <strong>{row.symbol}</strong>
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
              <td className={`num mono tone-${directionTone(row.direction)}`}>{signed(row.score, 3)}</td>
              <td className="num mono">{num(Number(row.confidence) * 100, 0)}%</td>
              <td className="num">
                {/* Verdicts are stored on material change only, so this is the path of
                    changes, not an evenly sampled series. The title says so. */}
                <span
                  className="trend-cell"
                  title={`${row.symbol} ${row.horizon || ''}: score across the last ${row.history?.length || 0} stored verdicts, oldest first`}
                >
                  <Sparkline values={row.history} domain={[-1, 1]} width={92} height={24} label={`${row.symbol} score path`} />
                </span>
              </td>
              <td>{componentPills(row.components)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
