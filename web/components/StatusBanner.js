// The one loud element on a page.
//
// Everything else in this interface is hairlines and quiet type, so this strip
// is deliberately the only thing that glows: it carries the single state a
// reader must not misread - whether the machine is delivering, how many names
// are actually ready, or whether this instance is even asking for a password.
//
// `facts` are key/value pairs rather than prose on purpose. A banner that
// narrates has to be read; a banner with numbers can be scanned.

export default function StatusBanner({ tone = 'sig', headline, facts = [], note = null }) {
  return (
    <section className={`banner-hud ${tone}`} aria-label="Current status">
      <i className="lamp" aria-hidden="true" />
      <h2 className="head">{headline}</h2>

      {facts.length ? (
        <div className="facts">
          {facts.map((fact) => (
            <span className="fact" key={fact.k}>
              <span className="fk">{fact.k}</span>
              <span className="fv">{fact.v}</span>
            </span>
          ))}
        </div>
      ) : null}

      {note ? <p className="note">{note}</p> : null}
    </section>
  );
}
