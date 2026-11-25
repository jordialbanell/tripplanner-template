// One photo per place, kept in the trip-photos storage bucket (see supabase/021_place_photos.sql).
// POST multipart {placeId, file}      → your own photo (the browser shrinks it first). Free.
// POST json {mode:"auto", placeIds}   → a Google photo for each place that has none. Paid.
// POST json {mode:"remove", placeId}  → back to no photo (and no automatic one).
import { NextRequest, NextResponse, connection } from 'next/server';
import { sharedDb } from '@/lib/shared-db';
import { getAccess, chargePaid } from '@/lib/trip/access';
import { searchPlaces } from '@/lib/trip/google';

export const maxDuration = 60;

const BUCKET = 'trip-photos';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_AUTO = 8;

async function ensureBucket() {
  const db = sharedDb();
  const { data } = await db.storage.getBucket(BUCKET);
  if (!data) await db.storage.createBucket(BUCKET, { public: true });
}

async function store(placeId: string, bytes: ArrayBuffer, type: string): Promise<string> {
  await ensureBucket();
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  // New name each time so phones don't keep showing a cached old photo.
  const path = `places/${placeId}-${Date.now()}.${ext}`;
  const { error } = await sharedDb().storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: true });
  if (error) throw new Error(error.message);
  return sharedDb().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function removeOld(url: string | null | undefined) {
  const marker = `/${BUCKET}/`;
  if (!url || !url.includes(marker)) return;
  await sharedDb().storage.from(BUCKET).remove([url.slice(url.indexOf(marker) + marker.length)]);
}

async function setPhoto(placeId: string, url: string) {
  const { error } = await sharedDb().from('places').update({ photo_url: url }).eq('id', placeId);
  if (error) throw new Error(error.message);
}

// Owner, or anyone holding an edit link.
async function canEdit() {
  const a = await getAccess();
  return { a, ok: a.owner || a.shares.some(s => s.role === 'edit') };
}

async function googlePhoto(place: { name: string; city: string | null; country: string | null; google_place_id: string | null }) {
  const key = process.env.TRIP_GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('Google key not configured');
  let id = place.google_place_id;
  if (!id) {
    const hits = await searchPlaces([place.name, place.city, place.country].filter(Boolean).join(', '), 1);
    id = hits[0]?.place_id || null;
  }
  if (!id) return null;
  const detail = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?fields=photos`, {
    headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(10000),
  });
  if (!detail.ok) return null;
  const { photos } = await detail.json() as { photos?: { name: string }[] };
  const name = photos?.[0]?.name;
  if (!name) return null;
  const media = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=1000`, {
    headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(15000),
  });
  if (!media.ok) return null;
  return { bytes: await media.arrayBuffer(), type: media.headers.get('content-type') || 'image/jpeg' };
}

export async function POST(req: NextRequest) {
  await connection();
  const { a, ok } = await canEdit();
  if (!ok) return NextResponse.json({ error: "This needs an edit link or the owner's sign-in." }, { status: 403 });

  // Your own photo.
  if ((req.headers.get('content-type') || '').includes('multipart/form-data')) {
    const form = await req.formData();
    const placeId = String(form.get('placeId') || '');
    const file = form.get('file');
    if (!placeId || !(file instanceof Blob)) return NextResponse.json({ error: 'Missing photo' }, { status: 400 });
    if (!file.type.startsWith('image/')) return NextResponse.json({ error: 'That is not a photo' }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Photo too big' }, { status: 413 });
    try {
      const { data: row } = await sharedDb().from('places').select('photo_url').eq('id', placeId).maybeSingle();
      const url = await store(placeId, await file.arrayBuffer(), file.type);
      await setPhoto(placeId, url);
      await removeOld(row?.photo_url);
      return NextResponse.json({ photo_url: url });
    } catch (e) {
      console.log('[photo] upload', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: 'Could not save the photo' }, { status: 500 });
    }
  }

  const body = await req.json().catch(() => ({}));

  if (body.mode === 'remove') {
    const placeId = String(body.placeId || '');
    const { data: row } = await sharedDb().from('places').select('photo_url').eq('id', placeId).maybeSingle();
    await setPhoto(placeId, 'none');
    await removeOld(row?.photo_url);
    return NextResponse.json({ photo_url: 'none' });
  }

  if (body.mode === 'auto') {
    const ids: string[] = (Array.isArray(body.placeIds) ? body.placeIds : []).map(String).slice(0, MAX_AUTO);
    const { data: rows, error } = await sharedDb().from('places')
      .select('id, name, city, country, google_place_id, photo_url').in('id', ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const todo = (rows || []).filter(r => !r.photo_url);
    if (!todo.length) return NextResponse.json({ results: {} });
    const charge = await chargePaid(a, body.tripId || null, 'photo', todo.length);
    if (!charge.ok) return NextResponse.json({ error: charge.error }, { status: charge.status });

    const results: Record<string, string> = {};
    await Promise.all(todo.map(async r => {
      try {
        const photo = await googlePhoto(r);
        const url = photo ? await store(r.id, photo.bytes, photo.type) : 'none';
        await setPhoto(r.id, url);
        results[r.id] = url;
      } catch (e) {
        console.log('[photo] auto', r.name, e instanceof Error ? e.message : e);
      }
    }));
    return NextResponse.json({ results });
  }

  return NextResponse.json({ error: 'Unknown request' }, { status: 400 });
}
