// A panel that can be folded away.
//
// The horizon page carries a lot of diagnostics. Some of it answers "what do
// I do?" and some of it answers "why did the machine do that?". The first kind
// stays open; the second kind is available but folded, so the page opens on
// the decision and the explanation is one click away.
//
// This is a native <details>, so it works without JavaScript, keeps its state
// across a live refresh, and is keyboard accessible for free.
export default function Collapsible({
  title,
  hint = '',
  badge = null,
  defaultOpen = false,
  children,
}) {
  return (
    <details className="card collapsible" open={defaultOpen}>
      <summary className="collapsible-head">
        <span className="collapsible-title">{title}</span>
        {badge != null ? <span className="collapsible-badge">{badge}</span> : null}
        <span className="collapsible-hint">{hint}</span>
        <span className="collapsible-marker" aria-hidden="true" />
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
