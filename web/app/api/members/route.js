import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { hashPassword } from '@/lib/password';

// Owner-only: add a family member to the same household.
export async function POST(request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (user.role !== 'owner') {
    return NextResponse.json({ error: 'Only the household owner can add members.' }, { status: 403 });
  }

  const sql = db();
  if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = body.role === 'owner' ? 'owner' : 'member';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  if (password.length < 10) {
    return NextResponse.json({ error: 'Password must be at least 10 characters.' }, { status: 400 });
  }

  try {
    const existing = await sql`select id from profiles where lower(email) = ${email} limit 1`;
    if (existing.length) {
      return NextResponse.json({ error: 'That email is already registered.' }, { status: 409 });
    }
    await sql`
      insert into profiles (household_id, email, password_hash, role)
      values (${user.household_id}::uuid, ${email}, ${hashPassword(password)}, ${role})
    `;
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Could not create member.' }, { status: 500 });
  }
}
