import { provenanceTone, provenanceLabel } from '@/lib/format';

// Slice 5.5: where a price came from. Angel One is the live broker feed; Yahoo is the free
// fallback and its NSE quotes lag the exchange by roughly fifteen minutes. Because that gap
// changes how much weight a number deserves, the source is shown next to anything priced off it
// rather than assumed - a delayed read never renders as a live one.
export default function Provenance({ value, className = 'pill' }) {
  if (!value) return null;
  return (
    <span className={`${className} ${provenanceTone(value)}`} title={String(value)}>
      {provenanceLabel(value)}
    </span>
  );
}
