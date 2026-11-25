import { NextRequest, NextResponse } from 'next/server';
import { computeHop, type LatLng } from '@/lib/trip/routes';
import { requirePaid } from '@/lib/trip/access';

// Real travel times for one hop: walk, transit and drive (with traffic).
// GET  /api/routes?from=22.28,114.15&to=22.29,114.17&time=2026-10-31T10:00:00+08:00  (handy for testing in a browser)
// POST /api/routes  { from: {lat,lng}, to: {lat,lng}, time?: ISO string }

function parsePoint(v: unknown): LatLng | null {
  if (typeof v === 'string') {
    const [lat, lng] = v.split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const p = v as LatLng | undefined;
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat, lng: p.lng } : null;
}

function parseTime(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function handle(fromRaw: unknown, toRaw: unknown, timeRaw: unknown) {
  const from = parsePoint(fromRaw);
  const to = parsePoint(toRaw);
  if (!from || !to) return NextResponse.json({ error: 'from and to are required (lat,lng)' }, { status: 400 });
  try {
    const result = await computeHop(from, to, parseTime(timeRaw));
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const denied = await requirePaid('routes');
  if (denied) return denied;
  const q = req.nextUrl.searchParams;
  return handle(q.get('from'), q.get('to'), q.get('time'));
}

export async function POST(req: NextRequest) {
  const denied = await requirePaid('routes');
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  return handle(body.from, body.to, body.time);
}
