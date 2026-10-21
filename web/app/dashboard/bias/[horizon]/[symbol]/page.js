import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getBiasVerdict } from '@/lib/queries';
import { istStamp, num, signed, pct, directionTone, scoreTone } from '@/lib/format';
import { horizonByKey } from '@/lib/horizons';

export const dynamic = 'force-dynamic';

function asText(value) {
  if (value == null) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return num(value, Math.abs(value) < 1 ? 3 : 2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  try { return JSON.stringify(value); } catch { return '-'; }
}

function entries(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item, index) => [String(index + 1), item]);
  if (typeof value === 'object') return Object.entries(value);
  return [['value', value]];
}

function itemLabel(item) {
  if (item == null) return '-';
  if (typeof item !== 'object') return String(item);
  const key = item.check || item.reason || item.label || item.name || item.rule || item.detail;
  const value = item.passed ?? item.ok ?? item.value ?? item.status;
  if (key && value !== undefined && String(key) !== String(value)) {
    return `${key}: ${asText(value)}`;
  }
  if (key) return String(key);
  return asText(item);
}

function Reasons({ items, empty = 'No reasons recorded.' }) {
  const rows = entries(items);
  if (!rows.length) return <p className="small muted">{empty}</p>;
  return (
    <ul className="evidence-list">
      {rows.map(([key, item]) => (
        <li key={key}>{itemLabel(item)}</li>
      ))}
    </ul>
  );
}

function ComponentsDetail({ value }) {
  const rows = entries(value);
  if (!rows.length) return <p className="small muted">No component breakdown recorded.</p>;
  return (
    <dl className="evidence-kv">
      {rows.map(([key, item]) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <span className="mono">
                  {item.score == null ? '-' : signed(Number(item.score), 3)}
                </span>
                {item.confidence != null ? (
                  <span className="muted"> conf {pct(Number(item.confidence) * 100, 0)}</span>
                ) : null}
                {item.detail ? <span className="muted"> {String(item.detail)}</span> : null}
                {item.available === false && <span className="muted"> (unavailable)</span>}
              </dd>
            </div>
          );
        }
        return (
          <div key={key}>
            <dt>{key}</dt>
            <dd className="mono">{asText(item)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export default async function BiasDetailPage({ params }) {
  const user = await getCurrentUser();
  if (!user) notFound();

  const { horizon: rawHorizon, symbol } = await params;
  const horizon = String(horizonByKey(rawHorizon)?.key || '').toUpperCase();
  if (!horizon || !symbol) notFound();

  const sql = db();
  let history = [];
  if (sql) {
    try {
      const rows = await sql`
        select direction, score, confidence, coverage, as_of, components, evidence, config_version, provenance
        from bias_verdicts
        where horizon = ${horizon} and symbol = ${symbol}
        order by as_of desc
        limit 30
      `;
      history = rows;
    } catch {
      history = [];
    }
  }

  const verdict = await getBiasVerdict(horizon, symbol);

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>Bias detail</h1>
          <p className="muted small">{symbol} \u00b7 {horizon}</p>
        </div>
        {verdict ? (
          <span className={`pill ${directionTone(verdict.direction)}`}>{verdict.direction}</span>
        ) : (
          <span className="pill muted">No verdict</span>
        )}
      </div>

      {verdict ? (
        <>
          <section className="card">
            <h2>Latest verdict</h2>
            <p className="hint">Read at {istStamp(verdict.as_of)} IST \u2014 config {verdict.config_version || '\u2014'} \u2014 engine {verdict.engine_version || '\u2014'}</p>

            <div className="evidence-facts">
              <span className={`pill ${directionTone(verdict.direction)}`}>{verdict.direction}</span>
              <span className="small muted">
                score <strong className={`mono ${scoreTone(verdict.score)}`}>{signed(Number(verdict.score), 3)}</strong>
              </span>
              <span className="small muted">
                confidence <strong className="mono">{pct(Number(verdict.confidence) * 100, 0)}</strong>
              </span>
              {verdict.coverage != null ? (
                <span className="small muted">
                  coverage <strong className="mono">{pct(Number(verdict.coverage) * 100, 0)}</strong>
                </span>
              ) : null}
              {verdict.provenance ? <span className="small muted">{verdict.provenance}</span> : null}
            </div>

            <h3>Component breakdown</h3>
            <ComponentsDetail value={verdict.components} />

            <h3>Evidence items</h3>
            <Reasons items={verdict.evidence} empty="The verdict carried no evidence items." />
          </section>

          {history.length > 1 ? (
            <>
              <section className="card">
                <h2>History</h2>
                <p className="hint">Verdicts are stored on material change only. Gaps mean no meaningful change occurred.</p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Time (IST)</th>
                        <th>Bias</th>
                        <th className="num">Score</th>
                        <th className="num">Conf</th>
                        <th className="num">Cov</th>
                        <th>Components</th>
                        <th>Config</th>
                        <th>Provenance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((row) => (
                        <tr key={row.as_of}>
                          <td className="small muted">{istStamp(row.as_of)}</td>
                          <td><span className={`pill ${directionTone(row.direction)}`}>{row.direction}</span></td>
                          <td className={`num mono ${scoreTone(row.score)}`}>{signed(Number(row.score), 3)}</td>
                          <td className="num mono">{pct(Number(row.confidence) * 100, 0)}%</td>
                          <td className="num mono">{row.coverage != null ? pct(Number(row.coverage) * 100, 0) + '%' : '-'}</td>
                          <td className="small mono">{row.components ? Object.keys(row.components).join(', ') : '-'}</td>
                          <td className="small muted">{row.config_version || '-'}</td>
                          <td className="small muted">{row.provenance || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card">
                <h2>Related signals</h2>
                <p className="hint">Published signals for this symbol/horizon that used this bias as input.</p>
                <div className="small muted">Linking via signal provenance is planned. For now, check the {horizon} published signals panel.</div>
              </section>
            </>
          ) : (
            <>
              <section className="card">
                <h2>Related signals</h2>
                <p className="hint">Published signals for this symbol/horizon that used this bias as input.</p>
                <div className="small muted">Linking via signal provenance is planned. For now, check the {horizon} published signals panel.</div>
              </section>
            </>
          )}

        </>
      ) : (
        <div className="card empty">
          <strong>No bias verdict for {symbol} / {horizon}</strong>
          The bias worker has not produced a verdict for this combination yet, or the row has been purged by retention.
        </div>
      )}
    </div>
  );
}