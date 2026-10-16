import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { db } from './db.js';

export const SESSION_COOKIE = 'tf_session';
const SESSION_DAYS = 30;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(profileId) {
  const sql = db();
  if (!sql) throw new Error('DATABASE_URL is not configured');
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await sql`
    insert into sessions (profile_id, token_hash, expires_at)
    values (${profileId}::uuid, ${hashToken(token)}, ${expiresAt})
  `;
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  return token;
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const sql = db();
  if (token && sql) {
    await sql`delete from sessions where token_hash = ${hashToken(token)}`.catch(() => {});
  }
  store.delete(SESSION_COOKIE);
}

// Verifies the cookie against the sessions table and returns the profile + household,
// or null. Also prunes the odd expired row and refreshes last_seen_at opportunistically.
export async function getCurrentUser() {
  const sql = db();
  if (!sql) return null;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await sql`
    select s.id as session_id,
           p.id as profile_id,
           p.email,
           p.role,
           p.household_id,
           h.name as household_name
    from sessions s
    join profiles p on p.id = s.profile_id
    join households h on h.id = p.household_id
    where s.token_hash = ${hashToken(token)} and s.expires_at > now()
    limit 1
  `.catch(() => []);
  if (!rows.length) return null;
  sql`update sessions set last_seen_at = now() where id = ${rows[0].session_id}::uuid`.catch(() => {});
  return rows[0];
}
