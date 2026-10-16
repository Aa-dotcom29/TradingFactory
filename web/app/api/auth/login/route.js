import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { DUMMY_HASH, verifyPassword } from '@/lib/password';
import { createSession } from '@/lib/auth';

export async function POST(request) {
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
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
  }

  let profile = null;
  try {
    const rows = await sql`select id, password_hash from profiles where lower(email) = ${email} limit 1`;
    profile = rows[0] || null;
  } catch (error) {
    return NextResponse.json({ error: 'Sign in is temporarily unavailable.' }, { status: 503 });
  }

  const ok = verifyPassword(password, profile ? profile.password_hash : DUMMY_HASH);
  if (!profile || !ok) {
    return NextResponse.json({ error: 'Incorrect email or password.' }, { status: 401 });
  }

  await createSession(profile.id);
  return NextResponse.json({ ok: true });
}
