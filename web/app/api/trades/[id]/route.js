import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(['SUCCESS', 'FAIL', 'OUTPERFORM', 'NEUTRAL']);

function emailOf(user) {
  return String((user && user.email) || '').trim().toLowerCase();
}

// Mark the person's own outcome on a trade. The evaluator's `outcomes` table is
// untouched: this is a journal entry, and the two records may legitimately
// disagree. Sending outcome OPEN reopens the trade and clears the mark.
export async function PATCH(request, { params }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

  const sql = db();
  if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });

  const { id } = await params;
  if (!UUID_RE.test(String(id || ''))) {
    return NextResponse.json({ error: 'A valid trade id is required.' }, { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  body = body && typeof body === 'object' ? body : {};

  const outcome = String(body.outcome || '').trim().toUpperCase();
  const reopen = outcome === 'OPEN' || body.reopen === true;
  if (!reopen && !OUTCOMES.has(outcome)) {
    return NextResponse.json(
      { error: 'Outcome must be SUCCESS, FAIL, OUTPERFORM, NEUTRAL or OPEN.' },
      { status: 400 },
    );
  }

  const note = body.note === undefined || body.note === null
    ? null
    : String(body.note).trim().slice(0, 500);
  const email = emailOf(user);
  if (!email) return NextResponse.json({ error: 'Signed-in user has no email.' }, { status: 400 });

  try {
    const rows = reopen
      ? await sql`
          update trade_entries
          set status = 'OPEN',
              outcome = null,
              outcome_at = null,
              outcome_note = null,
              notes = coalesce(${note}, notes),
              updated_at = now()
          where id = ${id}::uuid and user_email = ${email}
          returning id, signal_id, status, outcome, entered_at, outcome_at, outcome_note
        `
      : await sql`
          update trade_entries
          set status = 'CLOSED',
              outcome = ${outcome},
              outcome_at = now(),
              outcome_note = ${note},
              notes = coalesce(${note}, notes),
              updated_at = now()
          where id = ${id}::uuid and user_email = ${email}
          returning id, signal_id, status, outcome, entered_at, outcome_at, outcome_note
        `;

    if (!rows.length) {
      return NextResponse.json({ error: 'Trade not found.' }, { status: 404 });
    }

    return NextResponse.json({ trade: rows[0] });
  } catch {
    return NextResponse.json({ error: 'Could not update the trade.' }, { status: 500 });
  }
}
