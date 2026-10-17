// The harness chain as a single instrument strip: W0 ingests, and each stage
// hands a smaller, more decided quantity to the next. Seeing the funnel shrink
// is the fastest way to tell whether the machine is working or merely running.
//
// Numbers are real row counts from the database, not progress bars.

export default function PipelineStrip({ nodes = [] }) {
  return (
    <div className="pipe">
      {nodes.map((node) => (
        <div className={`node${node.terminal ? ' terminal' : ''}`} key={node.id}>
          <div className="id">{node.id}</div>
          <div className="name">{node.name}</div>
          <div className="n">
            {node.value}
            {node.unit ? <span className="u">{node.unit}</span> : null}
          </div>
          {node.note ? <div className="small muted">{node.note}</div> : null}
        </div>
      ))}
    </div>
  );
}
