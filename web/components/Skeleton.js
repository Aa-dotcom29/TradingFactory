// A page-shaped placeholder for the App Router's loading boundary. It mirrors
// the real page's rhythm - head, banner, then cards - so the layout does not
// jump when the server data arrives. No fake numbers and no fake labels: an
// empty bar is honest about not knowing yet.

export default function Skeleton({ rows = 3 }) {
  return (
    <div className="stack skeleton" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dashboard data</span>
      <div className="sk sk-title" />
      <div className="sk sk-banner" />
      {Array.from({ length: rows }).map((_, index) => (
        <div className="card sk-card" key={index}>
          <div className="sk sk-line" style={{ width: '22%' }} />
          <div className="sk sk-sub" style={{ width: '58%' }} />
          <div className="sk-row">
            <div className="sk sk-tile" />
            <div className="sk sk-tile" />
            <div className="sk sk-tile" />
          </div>
          <div className="sk sk-line" style={{ width: '76%' }} />
          <div className="sk sk-line" style={{ width: '44%' }} />
        </div>
      ))}
    </div>
  );
}
