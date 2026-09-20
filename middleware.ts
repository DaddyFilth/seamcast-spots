import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ALLOWED = new Set([
  'https://fishfinder-pro.online',
  'https://seamcast-g0jya8jpj-daddyfilths-projects.vercel.app',
]);

export function middleware(req: NextRequest) {
  const origin = req.headers.get('origin') || '';
  const headers = new Headers();
  if (ALLOWED.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers });
  }
  const res = NextResponse.next();
  headers.forEach((value, key) => res.headers.set(key, value));
  return res;
}

export const config = { matcher: '/api/:path*' };
