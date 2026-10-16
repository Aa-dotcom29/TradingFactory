import { NextResponse } from 'next/server';

// Cheap gate: only checks that a session cookie is present. The cookie is fully
// verified against the sessions table inside the server components / route handlers
// (middleware runs on the edge runtime and must not open a database connection).
export function middleware(request) {
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
