import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="empty">
      <strong>Unknown horizon</strong>
      That section does not exist. Use Intraday, Swing or Positional.
      <div style={{ marginTop: 12 }}>
        <Link className="btn ghost" href="/dashboard">
          Back to overview
        </Link>
      </div>
    </div>
  );
}
