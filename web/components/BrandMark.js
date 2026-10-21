// The brand mark.
//
// The rail mark is 22 pixels tall, so the whole idea has to survive being
// reduced to a thumbnail: a few strokes, no detail, one silhouette.
//
// Four concepts are provided, because the mark has to answer two questions at
// once and there are more than one honest answer.
//
//   'target'   a candle with its target line and the point where it was hit.
//               Reads as a signal and the price it is aiming at.
//   'bars'     three ascending candles, the tallest one wicking above them.
//               Reads as a certain direction and a prepared series.
//   'foundry'  a raw price line poured into a mould. Reads as charts being
//               prepared, which is what the machine does.
//   'reticle'  a targeting reticle with a rising line inside it. Reads as
//               sure signals and targets at the same time.
//
// The active one is set by VARIANT below. Change the one word to swap it; the
// rail and the mark scale themselves.

const VARIANT = 'reticle';

const ACCENT = 'var(--sig)';
const INK = 'currentColor';

const MARKS = {
  // A candlestick, the target line above it, and the hit marked on the line.
  target: (
    <>
      <path d="M16 2.5 V29.5" stroke={INK} strokeWidth="1.9" strokeLinecap="round" />
      <rect x="11.5" y="12.5" width="9" height="11" rx="1" fill={INK} />
      <path d="M4.5 8 H27.5" stroke={ACCENT} strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="16" cy="8" r="2.7" fill={ACCENT} />
    </>
  ),

  // Three candles in a row, rising, the tallest wicking past the others.
  bars: (
    <>
      <rect x="4" y="20" width="6.5" height="8" rx="1.4" fill={INK} opacity="0.45" />
      <rect x="12.75" y="14" width="6.5" height="14" rx="1.4" fill={INK} opacity="0.72" />
      <rect x="21.5" y="8" width="6.5" height="20" rx="1.4" fill={INK} />
      <path d="M24.75 2.5 V8" stroke={ACCENT} strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),

  // A raw price line poured into a mould, and a clean bar cast out of it.
  foundry: (
    <>
      <path
        d="M3 10 L9 6.5 L14 12 L20 4.5 L26 8.5"
        fill="none"
        stroke={INK}
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 18 H21 L23.5 22 V29 H8.5 V22 Z" fill="none" stroke={ACCENT} strokeWidth="2.1" strokeLinejoin="round" />
      <path d="M16 22 V29" stroke={ACCENT} strokeWidth="2.1" strokeLinecap="round" />
    </>
  ),

  // A targeting reticle with a rising line inside it.
  reticle: (
    <>
      <circle cx="16" cy="16" r="10.5" fill="none" stroke={INK} strokeWidth="2" opacity="0.45" />
      <path
        d="M16 2 V8 M16 24 V30 M2 16 H8 M24 16 H30"
        stroke={INK}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M8.5 21 L14 15.5 L18 18 L24 10.5"
        fill="none"
        stroke={ACCENT}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
};

export default function BrandMark({ variant = VARIANT, size = 22, title = 'Trading Factory' }) {
  const mark = MARKS[variant] || MARKS.reticle;
  return (
    <span className="brand-mark" style={{ width: size, height: size }} role="img" aria-label={title}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
        {mark}
      </svg>
    </span>
  );
}

export { MARKS, VARIANT };
