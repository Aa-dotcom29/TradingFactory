import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getSignalDossier, getIndexTimeframeBias } from '@/lib/queries';
import { getRiskContext } from '@/lib/risk-context';

export const dynamic = 'force-dynamic';

// The signal dossier behind the drawer's "full analysis" view. One signal at a
// time, so the page itself stays light and the drawer loads on demand.
export async function GET(request, { params }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

  const { id } = await params;
  const email = String((user && user.email) || '').trim().toLowerCase();
  const dossier = await getSignalDossier(id, email);
  if (!dossier) return NextResponse.json({ error: 'Signal not found.' }, { status: 404 });

  // Timeframe alignment only makes sense for the index names, so it is only
  // fetched for those.
  const bias = await getIndexTimeframeBias();
  const symbol = String(dossier.signal.symbol || '').toUpperCase();
  const timeframes = bias[symbol] || null;

  // The household state the gate read: exposure, the day's cost, the loss
  // streak. Without it, "every gate passed" is an assertion rather than a fact.
  const riskContext = await getRiskContext();

  return NextResponse.json({ dossier, timeframes, riskContext, at: new Date().toISOString() });
}
