import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth';

export async function POST() {
  await destroySession().catch(() => {});
  return NextResponse.json({ ok: true });
}
