import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getHealth } from '@/lib/queries';
import { arcadeTotals, buildArcadeWorkers } from '@/lib/arcade';

export const dynamic = 'force-dynamic';

// The rail's heartbeat strip polls this. It returns the same computed worker
// liveness the agents workspace board uses, so the two can never disagree: a worker is
// up here only while its own sources_health rows are fresh enough to prove it.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

  const health = await getHealth();
  const workers = buildArcadeWorkers(health.sources || []);
  return NextResponse.json({
    configured: health.configured,
    error: health.error,
    workers,
    totals: arcadeTotals(workers),
    at: new Date().toISOString(),
  });
}
