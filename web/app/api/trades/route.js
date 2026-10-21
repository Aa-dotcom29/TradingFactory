import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getUserTrades } from '@/lib/queries';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emailOf(user) {
  return String((user && user.email) || '').trim().toLowerCase();
}

// Record that the signed-in person entered a published signal. The operation is
// idempotent on (signal_id, user_email): pressing the button twice reopens the
// same workspace instead of creating a second position for one plan.
export async function POST(request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

  const sql = db();
  if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  body = body && typeof body === 'object' ? body : {};

  const signalId = String(body.signalId || '').trim();
  if (!UUID_RE.test(signalId)) {
    return NextResponse.json({ error: 'A valid signal id is required.' }, { status: 400 });
  }

  const email = emailOf(user);
  if (!email) return NextResponse.json({ error: 'Signed-in user has no email.' }, { status: 400 });

  try {
    const signals = await sql`
      select s.id, s.entry,
             (select t.id from trade_entries t
              where t.signal_id = s.id and t.user_email = ${email}
              limit 1) as existing_trade_id,
             (select e.new_state from signal_events e
              where e.signal_id = s.id order by e.at desc limit 1) as latest_state,
             coalesce((select c.status from config_registry c
              where c.family = 'risk' and c.version = s.snapshot->>'riskConfigVersion'),
              'approved') as risk_config_status
      from signals s
      where s.id = ${signalId}::uuid
      limit 1
    `;
    if (!signals.length) {
      return NextResponse.json({ error: 'Signal not found.' }, { status: 404 });
    }

    // Reopening an existing journal entry is always allowed; creating a new one is not.
    if (signals[0].existing_trade_id) {
      const existing = await sql`
        select id, signal_id, status, outcome, entered_at, entry_price
        from trade_entries
        where id = ${signals[0].existing_trade_id}::uuid and user_email = ${email}
        limit 1
      `;
      if (!existing.length) {
        return NextResponse.json({ error: 'Trade entry not found.' }, { status: 404 });
      }
      return NextResponse.json({ trade: existing[0] }, { status: 200 });
    }

    const latestState = String(signals[0].latest_state || '').toUpperCase();
    const configStatus = String(signals[0].risk_config_status || 'approved').toLowerCase();
    if (['VOIDED', 'EXITED', 'EXPIRED'].includes(latestState) || configStatus !== 'approved') {
      return NextResponse.json({
        error: 'This signal is not actionable: it was voided, already closed, or written under a retired risk config.',
      }, { status: 409 });
    }

    const rows = await sql`
      insert into trade_entries (signal_id, profile_id, user_email, entry_price)
      values (
        ${signalId}::uuid,
        ${user.profile_id || null}::uuid,
        ${email},
        ${signals[0].entry}
      )
      on conflict (signal_id, user_email) do update
        set user_email = excluded.user_email
      returning id, signal_id, status, outcome, entered_at, entry_price
    `;

    return NextResponse.json({ trade: rows[0] }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'Could not record the trade entry.' }, { status: 500 });
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

  const email = emailOf(user);
  if (!email) return NextResponse.json({ error: 'Signed-in user has no email.' }, { status: 400 });

  const trades = await getUserTrades(email, 100);
  return NextResponse.json({ trades });
}
