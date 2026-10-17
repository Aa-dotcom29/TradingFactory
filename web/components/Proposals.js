import { istStamp, num } from '@/lib/format';

// Slice 7's other half: the learning loop. The evaluator may propose a change to its own risk
// limits; it can never apply one.
//
// Every worker resolves the latest *approved* config version, and a proposal is written with
// status `candidate`, so an unapproved proposal has no effect on any part of the pipeline. It is a
// request that waits for a person. Approving it is a deliberate, auditable act:
//
//   npm run harness:config -- --list
//   npm run harness:config -- --approve=risk-w7-20261017T101500
//
// The panel exists so a proposal cannot sit unseen. An unread suggestion is the same as no
// suggestion, and the whole point of the loop is that it reaches someone.

function changeLine(metrics) {
  const change = (metrics && metrics.change) || null;
  if (!change) return null;
  return `${change.path}: ${num(change.from, 4)} to ${num(change.to, 4)} (${change.direction})`;
}

export default function Proposals({ proposals = [] }) {
  if (!proposals.length) {
    return (
      <div className="empty">
        <strong>Nothing awaiting approval</strong>
        The evaluator proposes a config change only once it has at least 30 closed trades behind it
        and the record is genuinely weak. Below that threshold it stays silent, because tuning
        weights against a dozen trades is how a quiet system talks itself into losses.
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Proposal</th>
            <th>Change</th>
            <th>Evidence</th>
            <th>Raised</th>
            <th>To approve</th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((proposal) => {
            const metrics = proposal.metrics || {};
            return (
              <tr key={proposal.version}>
                <td>
                  <strong className="mono">{proposal.version}</strong>
                  <div className="small muted">
                    family {proposal.family} &middot; by {proposal.created_by || 'unknown'}
                  </div>
                </td>
                <td className="mono small">
                  <span className="pill warn">proposed</span>
                  <div>{changeLine(metrics) || 'change not recorded'}</div>
                </td>
                <td className="small muted">
                  {metrics.reason || 'no reason recorded'}
                  {metrics.sample != null ? (
                    <div>
                      sample {metrics.sample} trades
                      {metrics.winRatePct != null ? `, win rate ${num(metrics.winRatePct, 1)}%` : ''}
                      {metrics.expectancyPct != null ? `, expectancy ${num(metrics.expectancyPct, 2)}%` : ''}
                    </div>
                  ) : null}
                </td>
                <td className="small muted">{istStamp(proposal.created_at)} IST</td>
                <td className="small mono">
                  npm run harness:config
                  <div className="muted">-- --approve={proposal.version}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
