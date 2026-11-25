import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { AssemblyAI } from 'assemblyai';
import type { PlacesResult } from '@/app/projects/tripplanner/api/places/route';
import { lookupPlaces } from '@/app/projects/tripplanner/api/places/route';
import { CATEGORY_GUIDE, normalizeCategory, type Category } from '@/app/projects/tripplanner/_components/placeTypes';
import { categoryFromTypes } from '@/lib/trip/google';
import { requirePaid } from '@/lib/trip/access';

// Vercel: allow up to 60s (Hobby plan max). Upgrade to Pro for reliable Instagram support (needs ~120s).
export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.TRIP_ANTHROPIC_API_KEY });
const assemblyClient = new AssemblyAI({ apiKey: process.env.TRIP_ASSEMBLYAI_API_KEY! });

export interface ExtractedPlace {
  name: string;
  location: string;
  city: string;
  country: string;
  category: Category;
  vibe: string;
  description: string;
  source_handle: string | null;
  geo: PlacesResult | null;
  geoAll: PlacesResult[];
  manyBranches: boolean;
}

interface TikTokOEmbed {
  title: string;
  author_name: string;
  author_url: string;
  html: string;
  thumbnail_url: string;
  provider_name: string;
}

interface ParsedCaption {
  title: string;
  handle: string | null;
  address: string | null;
}

function parseCaption(title: string): ParsedCaption {
  const handleMatch = title.match(/📍@(\w+)/);
  const handle = handleMatch ? handleMatch[1] : null;
  const addressMatch = title.match(/📍(?:@\w+,?\s*)?([\w\s]+(?:Rd|St|Ave|Blvd|Ln|Dr|Cres|Way|Pl|Terrace|Road|Street|Avenue|Lane|Drive|Close|Walk)[^,\n]*(?:,\s*(?:Singapore|Malaysia|Thailand|Indonesia|Japan|Korea|France|Italy|Spain|UK|USA|Australia)\s*\d*)?)/i);
  const address = addressMatch ? addressMatch[1].trim() : null;
  return { title, handle, address };
}

async function fetchTikTokMetadata(url: string): Promise<{ metadata: string; parsed: ParsedCaption }> {
  const oEmbedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetch(oEmbedUrl, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`TikTok oEmbed request failed: ${res.status} ${res.statusText}`);
  const data: TikTokOEmbed = await res.json();
  if (!data.title && !data.author_name) throw new Error('TikTok oEmbed returned no usable metadata');

  const parsed = parseCaption(data.title || '');
  console.log("[caption] handle:", parsed.handle, "address:", parsed.address);
  const metadata = [
    data.author_name && `Author: ${data.author_name}`,
    data.title       && `Title: ${data.title}`,
    `URL: ${url}`,
  ].filter(Boolean).join('\n');

  return { metadata, parsed };
}

// Share-sheet links (vm.tiktok.com/..., vt.tiktok.com/..., tiktok.com/t/...) are redirects.
// Follow them to the real post URL, which oEmbed and the scraper both handle better.
async function resolveTikTokUrl(url: string): Promise<string> {
  try {
    const u = new URL(url);
    const short = /^(vm|vt)\.tiktok\.com$/i.test(u.hostname) || u.pathname.startsWith('/t/');
    if (!short) return url;
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
      signal: AbortSignal.timeout(8000),
    });
    const final = new URL(res.url);
    if (!/tiktok\.com$/i.test(final.hostname) || !/\/(video|photo)\//.test(final.pathname)) return url;
    return `${final.origin}${final.pathname}`;
  } catch (err) {
    console.log('[tiktok] could not resolve short link:', err instanceof Error ? err.message : err);
    return url;
  }
}

interface TikTokPost { audioUrl: string | null; caption: string | null; author: string | null }

async function fetchTikTokPost(tiktokUrl: string): Promise<TikTokPost | null> {
  const apifyToken = process.env.TRIP_APIFY_API_TOKEN;
  if (!apifyToken) return null;

  try {
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postURLs: [tiktokUrl],
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
          shouldDownloadSubtitles: false,
          shouldDownloadSlideshowImages: false,
        }),
      }
    );
    if (!runRes.ok) return null;
    const runData = await runRes.json();
    const runId = runData?.data?.id;
    if (!runId) return null;

    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      const statusData = await statusRes.json();
      const status = statusData?.data?.status;
      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED' || status === 'ABORTED') return null;
    }

    const datasetRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apifyToken}`);
    const items = await datasetRes.json();
    const item = items?.[0];
    if (!item) return null;
    return {
      audioUrl: item?.musicMeta?.playUrl || item?.videoMeta?.downloadAddr || null,
      caption: typeof item?.text === 'string' && item.text.trim() ? item.text : null,
      author: item?.authorMeta?.name || item?.authorMeta?.nickName || null,
    };
  } catch (err) {
    console.log("[apify] error:", err);
    return null;
  }
}

async function fetchInstagramData(instagramUrl: string): Promise<{ metadata: string; parsed: ParsedCaption; transcript: string | null } | null> {
  const apifyToken = process.env.TRIP_APIFY_API_TOKEN;
  if (!apifyToken) return null;

  try {
    console.log("[instagram] starting apify run for:", instagramUrl);
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-reel-scraper/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: [instagramUrl],
          includeTranscript: true,
          resultsLimit: 1,
        }),
      }
    );
    if (!runRes.ok) {
      console.log("[instagram] apify run failed:", await runRes.text());
      return null;
    }
    const runData = await runRes.json();
    const runId = runData?.data?.id;
    if (!runId) return null;
    console.log("[instagram] run id:", runId);

    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      const statusData = await statusRes.json();
      const status = statusData?.data?.status;
      console.log("[instagram] status:", status);
      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED' || status === 'ABORTED') return null;
    }

    const datasetRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apifyToken}`);
    const items = await datasetRes.json();
    const item = items?.[0];
    if (!item) return null;

    console.log("[instagram] got item, caption length:", item.caption?.length ?? 0);

    const caption = item.caption || '';
    const locationName = item.locationName || '';
    const transcript = item.transcript || null;

    const parsed = parseCaption(caption);

    const metadata = [
      item.ownerUsername && `Author: ${item.ownerUsername}`,
      caption && `Caption: ${caption}`,
      locationName && `Location tag: ${locationName}`,
      `URL: ${instagramUrl}`,
    ].filter(Boolean).join('\n');

    return { metadata, parsed, transcript };
  } catch (err) {
    console.log("[instagram] error:", err);
    return null;
  }
}

async function transcribeAudio(audioUrl: string): Promise<string | null> {
  try {
    const transcript = await assemblyClient.transcripts.transcribe({
      audio_url: audioUrl,
      speech_models: ['universal-2'],
    });
    console.log("[assemblyai] status:", transcript.status, "error:", transcript.error, "text length:", transcript.text?.length ?? 0);
    return transcript.text || null;
  } catch (err) {
    console.log("[assemblyai] error:", err);
    return null;
  }
}

function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function extractPlacesWithClaude(metadata: string, transcript: string | null): Promise<Omit<ExtractedPlace, 'geo'>[]> {
  const transcriptSection = transcript
    ? `\nVideo transcript:\n${transcript}`
    : '\n(No transcript available)';

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Extract ALL places mentioned in this social media post. Return ONLY a valid JSON array of objects. Each object must have these exact keys:
- "name": place name (string)
- "location": street address or neighbourhood if available, otherwise empty string
- "city": city name (string)
- "country": country name (string)
- "category": exactly one of the keys below, nothing else:
${CATEGORY_GUIDE}
- "vibe": a short 3-6 word phrase describing the atmosphere (e.g. "cosy jazz wine bar")
- "description": 3-5 sentences about what makes this place special, written as if recommending it to a friend. Include specific details like signature dishes, prices, ambience, what the creator said or showed, and why it's worth visiting.

IMPORTANT RULES:
- Return an ARRAY even if only one place is found. E.g. [{ ... }]
- For "name": if a place handle appears in the caption, derive the place name from that handle.
- For "location": The full caption is included below — extract the full street address directly from it if present, and use it for the Google Places lookup. Look for addresses that may appear on separate lines after a place name or emoji pin. Use the address exactly as written.
- For "description": be specific and useful. Pull concrete details from the transcript. If no transcript, use the caption.

Caption / metadata (PRIMARY SOURCE):
${metadata}
${transcriptSection}

Respond with only the JSON array, no markdown, no explanation.`,
      },
    ],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
console.log("[claude] raw response:", raw.substring(0, 200));
const parsed_result = JSON.parse(cleaned);
  return Array.isArray(parsed_result) ? parsed_result : [parsed_result];
}

type UrlType = 'tiktok' | 'instagram' | 'googlemaps' | 'unknown';
type SendFn = (event: string, data: unknown) => void;

function detectUrlType(url: string): UrlType {
  if (url.includes('tiktok.com') || url.includes('vm.tiktok.com')) return 'tiktok';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('maps.app.goo.gl') || url.includes('google.com/maps') || url.includes('maps.google.com')) return 'googlemaps';
  return 'unknown';
}

async function handleTikTok(url: string, send: SendFn): Promise<void> {
  send('status', { stage: 'Fetching video info...' });
  const postUrl = await resolveTikTokUrl(url);
  if (postUrl !== url) console.log('[tiktok] resolved short link to', postUrl);

  // oEmbed first (fast, free). If it comes back empty (some short links, photo posts),
  // fall back to the caption the scraper returns below.
  let metadata: string | null = null;
  let parsed: ParsedCaption | null = null;
  let oembedError: string | null = null;
  try {
    ({ metadata, parsed } = await fetchTikTokMetadata(postUrl));
  } catch (err) {
    oembedError = err instanceof Error ? err.message : 'Failed to fetch URL';
    console.log('[tiktok] oEmbed failed, trying the scraper:', oembedError);
  }

  let transcript: string | null = null;
  send('status', { stage: metadata ? 'Downloading audio...' : 'Reading the post...' });
  const post = await fetchTikTokPost(postUrl);

  if (!metadata || !parsed) {
    if (!post?.caption && !post?.author) {
      send('error', { error: "Couldn't read this TikTok. It may be private or deleted. Try the link again, or add the place by name." });
      return;
    }
    const caption = post.caption || '';
    parsed = parseCaption(caption);
    metadata = [
      post.author && `Author: ${post.author}`,
      caption && `Title: ${caption}`,
      `URL: ${postUrl}`,
    ].filter(Boolean).join('\n');
  }

  if (post?.audioUrl) {
    send('status', { stage: 'Transcribing audio...' });
    transcript = await transcribeAudio(post.audioUrl);
  }

  await extractAndGeocode(metadata, parsed, transcript, send);
}

async function handleInstagram(url: string, send: SendFn): Promise<void> {
  send('status', { stage: 'Fetching Instagram reel...' });
  const igData = await fetchInstagramData(url);
  if (!igData) {
    send('error', { error: 'Could not fetch Instagram reel. Make sure it is a public reel.' });
    return;
  }

  await extractAndGeocode(igData.metadata, igData.parsed, igData.transcript, send);
}

async function handleGoogleMaps(url: string, send: SendFn, boardId?: string): Promise<void> {
  send('status', { stage: 'Looking up place...' });

  let resolvedUrl = url;
  if (url.includes('maps.app.goo.gl')) {
    try {
      const redirectRes = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      resolvedUrl = redirectRes.url;
    } catch {
      send('error', { error: 'Could not resolve shortened Google Maps URL' });
      return;
    }
  }

  let placeName: string | null = null;

  // 1. Try /place/PlaceName/ in the path
  const placePathMatch = resolvedUrl.match(/\/place\/([^/?]+)/);
  if (placePathMatch) {
    placeName = decodeURIComponent(placePathMatch[1].replace(/\+/g, ' '));
  }

  // 2. Try ?q= query parameter
  if (!placeName) {
    try {
      const resolved = new URL(resolvedUrl);
      placeName = resolved.searchParams.get('q');
    } catch { /* ignore parse errors */ }
  }

  // 3. Try ?query= query parameter
  if (!placeName) {
    try {
      const resolved = new URL(resolvedUrl);
      placeName = resolved.searchParams.get('query');
    } catch { /* ignore parse errors */ }
  }

  if (!placeName) {
    send('error', { error: 'Could not extract place name from Google Maps URL' });
    return;
  }

  // Combine place name (first part) + region/country (last two parts), dropping noisy
  // middle address parts. E.g. "Tam Coc Pet Coffee, Street, District, Ninh Bình, Vietnam"
  // → "Tam Coc Pet Coffee, Ninh Bình, Vietnam"
  const parts = placeName.split(',').map(p => p.trim());
  const searchQuery = parts.length <= 3
    ? placeName
    : [parts[0], ...parts.slice(-2)].join(', ');

  console.log('[extract] Google Maps searchQuery:', searchQuery);

  let geoResults: PlacesResult[] = [];
  try {
    geoResults = await lookupPlaces(searchQuery, '', '');
  } catch (err) {
    console.error('[extract] google maps lookupPlaces failed:', err);
  }

  if (geoResults.length === 0) {
    send('error', { error: `No results found for "${placeName}"` });
    return;
  }

  const topResult = geoResults[0];

  // Check for duplicate place on the same board (within ~100m)
  if (boardId && topResult.lat && topResult.lng) {
    const supabaseUrl = process.env.NEXT_PUBLIC_TRIP_SUPABASE_URL || process.env.SHARED_SUPABASE_URL;
    const supabaseKey = process.env.TRIP_SUPABASE_SERVICE_ROLE_KEY || process.env.SHARED_SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseKey) {
      const latMin = topResult.lat - 0.001;
      const latMax = topResult.lat + 0.001;
      const lngMin = topResult.lng - 0.001;
      const lngMax = topResult.lng + 0.001;
      const query = `board_id=eq.${boardId}&lat=gte.${latMin}&lat=lte.${latMax}&lng=gte.${lngMin}&lng=lte.${lngMax}&select=id,name,lat,lng&limit=1`;
      try {
        const dupRes = await fetch(`${supabaseUrl}/rest/v1/places?${query}`, {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
          signal: AbortSignal.timeout(5000),
        });
        if (dupRes.ok) {
          const dups = await dupRes.json();
          if (Array.isArray(dups) && dups.length > 0) {
            const existing = dups[0];
            send('error', { error: 'already_saved', place: { id: existing.id, name: existing.name, lat: existing.lat, lng: existing.lng } });
            return;
          }
        }
      } catch (err) {
        console.error('[extract] duplicate check failed:', err);
      }
    }
  }

  const category: Category = categoryFromTypes(topResult.types || []) ?? 'Attraction';

  const result: ExtractedPlace = {
    name: topResult.name || placeName,
    location: topResult.address,
    city: topResult.city,
    country: topResult.country,
    category,
    vibe: '',
    description: '',
    source_handle: null,
    geo: geoResults[0],
    geoAll: geoResults,
    manyBranches: geoResults.length >= 4,
  };

  send('result', { places: [result] });
}

async function extractAndGeocode(metadata: string, parsed: ParsedCaption, transcript: string | null, send: SendFn): Promise<void> {
  send('status', { stage: 'Extracting places...' });

  let places: Omit<ExtractedPlace, 'geo'>[];
  try {
    places = await extractPlacesWithClaude(metadata, transcript);
  } catch {
    send('error', { error: 'Model returned unparseable response' });
    return;
  }

  if (places.length === 0) {
    send('result', { places: [] });
    return;
  }

  send('status', { stage: 'Pinning on map...' });

  const results: ExtractedPlace[] = [];

  for (const place of places) {
    const geoQuery = place.location
      ? { name: place.location, city: place.city, country: place.country }
      : { name: place.name, city: place.city, country: place.country };
    const sourceHandle = parsed.handle || null;
    let geoResults: PlacesResult[] = [];
    if (geoQuery.name) {
      try {
        console.log('[extract] geoQuery:', JSON.stringify(geoQuery));
        geoResults = await lookupPlaces(geoQuery.name, geoQuery.city || '', geoQuery.country || '');
        console.log('[extract] lookupPlaces results:', geoResults.length);
      } catch (err) {
        console.error('[extract] lookupPlaces failed:', err);
      }
    }

    const category: Category = normalizeCategory(place.category)
      ?? categoryFromTypes(geoResults[0]?.types || []) ?? 'Restaurant';

    results.push({
      ...place,
      category,
      source_handle: sourceHandle,
      geo: geoResults[0] ?? null,
      geoAll: geoResults,
      manyBranches: geoResults.length >= 4,
    });
  }

  send('result', { places: results });
}

export async function POST(req: NextRequest) {
  const denied = await requirePaid('extract');
  if (denied) return denied;
  let url: string;
  let boardId: string | undefined;
  try {
    const body = await req.json();
    url = body?.url?.trim();
    boardId = body?.board_id;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!url) return NextResponse.json({ error: '`url` is required' }, { status: 400 });
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  const urlType = detectUrlType(url);

  // Strip query params for social media URLs (not needed), but keep full URL for Google Maps
  if (urlType !== 'googlemaps') {
    const parsedUrl = new URL(url);
    url = `${parsedUrl.origin}${parsedUrl.pathname}`;
  }

  if (urlType === 'unknown') {
    return NextResponse.json(
      { error: 'Unsupported URL. Please paste a TikTok, Instagram, or Google Maps link.' },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(sseMessage(event, data)));
      }

      try {
        switch (urlType) {
          case 'tiktok':     await handleTikTok(url, send); break;
          case 'instagram':  await handleInstagram(url, send); break;
          case 'googlemaps': await handleGoogleMaps(url, send, boardId); break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unexpected error';
        send('error', { error: message });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
