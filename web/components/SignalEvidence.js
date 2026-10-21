import Link from 'next/link';
import { directionTone, istStamp, num, pct, signed } from '@/lib/format';

// "Why this signal" is a provenance drawer, not a second opinion. Every value
// here was read from the rows that existed at publication: the bias verdict the
// builder consumed, the risk gate's own decision, and the lifecycle stage the
// candidate was raised from. If a row is absent the panel says so; it never
// substitutes the latest verdict for the one that was actually used.

function asText(value) {
  if (value == null) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return num(value, Math.abs(value) < 1 ? 3 : 2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  try {
    return JSON.stringify(value);
  } catch {
    return '-';
  }
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

function Components({ value }) {
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

export default function SignalEvidence({ evidence }) {
  // Undefined means the evidence query could not run (no database, transient
  // error). The rest of the page already carries that failure, so staying quiet
  // here avoids repeating the same banner on every card.
  if (!evidence) return null;

  const verdict = evidence.verdict;
  const risk = evidence.risk;
  const stage = evidence.stage;

  return (
    <details className="evidence">
      <summary>
        <span className="evidence-toggle">Why this signal</span>
        <span className="muted tick">verdict, gate and stage as of publication</span>
      </summary>

      <div className="evidence-body">
        <div className="grid cols-2">
          <div>
            <h3>Bias used</h3>
            {verdict ? (
              <>
                <div className="evidence-facts">
                  <span className={`pill ${directionTone(verdict.direction)}`}>
                    {verdict.direction}
                  </span>
                  <span className="small muted">
                    score <strong className={`mono ${Number(verdict.score) > 0 ? 'up' : Number(verdict.score) < 0 ? 'down' : ''}`}>
                      {signed(Number(verdict.score), 3)}
                    </strong>
                  </span>
                  <span className="small muted">
                    confidence <strong className="mono">{pct(Number(verdict.confidence) * 100, 0)}</strong>
                  </span>
                  {verdict.coverage != null ? (
                    <span className="small muted">
                      coverage <strong className="mono">{pct(Number(verdict.coverage) * 100, 0)}</strong>
                    </span>
                  ) : null}
                </div>
                <p className="small muted" style={{ margin: '6px 0 8px' }}>
                  as of {istStamp(verdict.as_of)} IST - config {verdict.config_version || '-'} - engine{' '}
                  {verdict.engine_version || '-'}
                </p>
                <Components value={verdict.components} />
                <h3>Evidence items</h3>
                <Reasons items={verdict.evidence} empty="The verdict carried no evidence items." />
              </>
            ) : (
              <p className="small muted">
                No bias verdict exists at or before this signal&apos;s publication time, so the
                verdict that fed the builder cannot be shown. It is not substituted with a later
                reading.
              </p>
            )}
          </div>

          <div>
            <h3>Risk gate</h3>
            {risk ? (
              <>
                <div className="evidence-facts">
                  <span className={`pill ${risk.passed ? 'up' : 'down'}`}>
                    {risk.decision || (risk.passed ? 'APPROVED' : 'BLOCKED')}
                  </span>
                  <span className="small muted">evaluated {istStamp(risk.evaluated_at)} IST</span>
                  {risk.config_version ? (
                    <span className="small muted">config {risk.config_version}</span>
                  ) : null}
                </div>
                <Reasons items={risk.reasons} empty="The gate recorded no reason list." />
              </>
            ) : (
              <p className="small muted">
                No risk decision row is linked to this signal. That is unusual for a published
                signal and is reported as missing rather than inferred.
              </p>
            )}

            <h3>Lifecycle stage</h3>
            {stage ? (
              <>
                <div className="evidence-facts">
                  <span className="pill">{stage.stage}</span>
                  {stage.direction ? (
                    <span className={`pill ${directionTone(stage.direction)}`}>{stage.direction}</span>
                  ) : null}
                  <span className="small muted">as of {istStamp(stage.as_of)} IST</span>
                </div>
                <Reasons items={stage.reasons} empty="The stage recorded no reasons." />
              </>
            ) : (
              <p className="small muted">
                No lifecycle stage was recorded at or before publication.
              </p>
            )}
          </div>
        </div>

        <div className="evidence-links small">
          <span className="muted">Trace:</span>
          <Link href="/dashboard/arcade/w3">W3 Bias</Link>
          <Link href="/dashboard/arcade/w4">W4 Signal</Link>
          <Link href="/dashboard/arcade/w5">W5 Risk</Link>
          <Link href="/dashboard/arcade/w6">W6 Publish</Link>
        </div>
      </div>
    </details>
  );
}
