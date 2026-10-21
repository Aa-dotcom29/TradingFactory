import Skeleton from '@/components/Skeleton';

// The Agents Workspace is one wide board followed by a report table, so its
// placeholder keeps that shape instead of showing generic cards.
export default function ArcadeLoading() {
  return (
    <div className="stack skeleton" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading worker board</span>
      <div className="sk sk-title" />
      <div className="sk sk-banner" />
      <div className="card sk-card">
        <div className="sk sk-board" />
      </div>
      <div className="card sk-card">
        <div className="sk sk-line" style={{ width: '18%' }} />
        <div className="sk sk-line" style={{ width: '92%' }} />
        <div className="sk sk-line" style={{ width: '84%' }} />
        <div className="sk sk-line" style={{ width: '88%' }} />
      </div>
    </div>
  );
}
