import { NextResponse } from 'next/server';

// Auth can be bypassed for local development only. Even when AUTH_DISABLED is requested,
// production always keeps the gate, so a misconfigured deploy can never become wide open.
const DEV_BYPASS = process.env.AUTH_DISABLED === 'true' && process.env.NODE_ENV !== 'production';

export function middleware(request) {
  if (DEV_BYPASS) return NextResponse.next();
  const token = request.cookies.get('tf_session')?.value;
  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/dashboard'],
};
