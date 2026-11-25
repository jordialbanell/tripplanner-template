// Builds the Barcelona demo trip that visitors see (owner only, one click, safe to repeat).
// Real places, picked by the owner (food) and checked by Claude (sights, coffee, bars) on 13 Oct 2026.
// Pins come from Google Places. Flights are clearly labelled samples, not anyone's real booking.
// POST -> { tripId, report: [{ query, matched, address }] } so the owner can check every pin.
import { NextResponse } from "next/server";
import { sharedDb } from "@/lib/shared-db";
import { searchPlaces, type PlaceHit } from "@/lib/trip/google";
import { requireOwner } from "@/lib/trip/access";
import { WISHLIST_BOARD_ID } from "@/lib/trip/constants";
import { DEFAULT_MINUTES } from "@/lib/trip/dayPlan";
import type { Category } from "@/app/projects/tripplanner/_components/placeTypes";

export const maxDuration = 60;

const START = "2027-05-13";
const END = "2027-05-16";
const HOTEL = { query: "Hotel Casa Fuster Barcelona", name: "Hotel Casa Fuster" };

const PLACES: { key: string; query: string; category: Category; mustGo?: boolean; note?: string }[] = [
  // the owner's list
  { key: "caracoles", query: "Los Caracoles restaurant Barcelona", category: "Restaurant", mustGo: true, note: "One of the oldest restaurants in Spain" },
  { key: "delacrem", query: "DelaCrem gelateria Barcelona", category: "Snacks", note: "Very good ice cream" },
  { key: "toscana", query: "Cremeria Toscana Barcelona", category: "Snacks", note: "Very good ice cream" },
  { key: "enric", query: "L'Enric restaurant paella Barcelona", category: "Restaurant", note: "Good paella" },
  { key: "petra", query: "Casa Petra restaurant Barcelona", category: "Restaurant", note: "Good paella" },
  { key: "balabusta", query: "La Balabusta restaurant Barcelona", category: "Restaurant", note: "Good Mediterranean" },
  { key: "pita", query: "La Pita Bonita Barcelona", category: "Restaurant", note: "Good Mediterranean" },
  { key: "marcel", query: "Bar Marcel tapas Barcelona", category: "Restaurant", note: "Good tapas" },
  { key: "omar", query: "Bar Omar Barcelona", category: "Restaurant", note: "Good tapas" },
  { key: "tomas", query: "Bar Tomás de Sarrià Barcelona", category: "Restaurant", mustGo: true, note: "Oldest bravas in Barcelona" },
  { key: "varmuteo", query: "Varmuteo Barcelona", category: "Restaurant", note: "Good tapas" },
  { key: "tap", query: "Cerveseria El Tap Barcelona", category: "Restaurant", note: "Good bravas" },
  { key: "yushu", query: "Yushu sushi Barcelona", category: "Restaurant", note: "Good sushi" },
  { key: "suguru", query: "Suguru Sushi Barcelona", category: "Restaurant", note: "Good sushi" },
  { key: "robata", query: "Robata restaurant Barcelona", category: "Restaurant", note: "Good sushi" },
  { key: "yakumanka", query: "Yakumanka Gastón Acurio Barcelona", category: "Restaurant", note: "Good Peruvian" },
  // Sights
  { key: "sagrada", query: "Basílica de la Sagrada Família Barcelona", category: "Attraction", mustGo: true },
  { key: "guell", query: "Park Güell Barcelona", category: "Attraction" },
  { key: "bunkers", query: "Bunkers del Carmel Barcelona", category: "Nature" },
  // Coffee
  { key: "satans", query: "Satan's Coffee Corner Barcelona", category: "Café" },
  { key: "nomad", query: "Nomad Coffee Lab Barcelona", category: "Café" },
  { key: "slowmov", query: "SlowMov Gràcia Barcelona", category: "Café" },
  // Bars
  { key: "paradiso", query: "Paradiso cocktail bar Barcelona", category: "Bar", mustGo: true },
  { key: "sips", query: "Sips cocktail bar Barcelona", category: "Bar" },
  { key: "boadas", query: "Boadas cocktail bar Barcelona", category: "Bar" },
];

// Day 2, planned, to show the schedule: times, a fixed booking and a "be there by".
const DAY2: { key: string; fixed?: string; by?: string }[] = [
  { key: "sagrada", fixed: "10:00" },
  { key: "delacrem" },
  { key: "caracoles", by: "14:00" },
  { key: "satans" },
  { key: "paradiso" },
];

const FLIGHTS = [
  "DEMO1 | 13/05/2027 | Both | Arriving | LHR-BCN | 09:40-12:55",
  "DEMO2 | 16/05/2027 | Both | Departing | BCN-LHR | 19:30-20:50",
];

async function pin(query: string): Promise<PlaceHit | null> {
  try { return (await searchPlaces(query, 1))[0] ?? null; } catch { return null; }
}

export async function POST() {
  const denied = await requireOwner();
  if (denied) return denied;
  const db = sharedDb();

  const existing = await db.from("trips").select("id").eq("is_demo", true).limit(1);
  if (existing.error) {
    return NextResponse.json({ error: "Run supabase/007_trip_sharing.sql first.", detail: existing.error.message }, { status: 500 });
  }
  if (existing.data?.length) return NextResponse.json({ tripId: existing.data[0].id, already: true });

  // Pins, a few at a time.
  const hits: Record<string, PlaceHit | null> = {};
  const queue = [...PLACES.map(p => ({ key: p.key, query: p.query })), { key: "hotel", query: HOTEL.query }];
  while (queue.length) {
    const batch = queue.splice(0, 6);
    const res = await Promise.all(batch.map(b => pin(b.query)));
    batch.forEach((b, i) => { hits[b.key] = res[i]; });
  }

  const { data: trip, error: tErr } = await db.from("trips").insert({
    name: "Barcelona", start_date: START, end_date: END, board_id: WISHLIST_BOARD_ID, is_demo: true,
  }).select("id").single();
  if (tErr || !trip) return NextResponse.json({ error: tErr?.message || "Trip not created" }, { status: 500 });
  const tripId = trip.id as string;

  const hotel = hits.hotel;
  const { data: leg } = await db.from("trip_legs").insert({
    trip_id: tripId, city: "Barcelona", country: "Spain", start_date: START, end_date: END, leg_order: 0,
    hotel: HOTEL.name, hotel_lat: hotel?.lat ?? null, hotel_lng: hotel?.lng ?? null, hotel_place_id: hotel?.place_id ?? null,
  }).select("id").single();

  await db.from("trip_flights").insert(FLIGHTS.map(f => ({ trip_id: tripId, flight_number: f })));

  const report: { query: string; matched: string | null; address: string | null }[] = [];
  const placeIds: Record<string, { id: string; name: string; lat: number; lng: number; address: string; category: Category }> = {};
  const rows = PLACES.filter(p => hits[p.key]).map(p => {
    const h = hits[p.key]!;
    return {
      key: p.key,
      row: {
        board_id: WISHLIST_BOARD_ID, name: h.name, city: "Barcelona", country: "Spain", category: p.category,
        lat: h.lat, lng: h.lng, address: h.address, google_place_id: h.place_id, neighbourhood: h.neighbourhood,
        vibe: "", description: null, tiktok_url: "", source_handle: null, must_go: !!p.mustGo, emoji: null,
        tags: [], been_here: false, rating: null, personal_note: p.note ?? "",
      },
    };
  });
  const { data: inserted, error: pErr } = await db.from("places").insert(rows.map(r => r.row)).select("id, google_place_id");
  if (pErr) return NextResponse.json({ error: pErr.message, tripId }, { status: 500 });
  for (const r of rows) {
    const got = (inserted || []).find(x => x.google_place_id === r.row.google_place_id);
    if (got) placeIds[r.key] = { id: got.id as string, name: r.row.name, lat: r.row.lat, lng: r.row.lng, address: r.row.address, category: r.row.category };
  }
  for (const p of PLACES) report.push({ query: p.query, matched: hits[p.key]?.name ?? null, address: hits[p.key]?.address ?? null });

  // The demo trip shows exactly these places.
  const included = Object.values(placeIds).map(p => ({ trip_id: tripId, place_id: p.id }));
  if (included.length) await db.from("trip_included_places").insert(included);

  // Day 2 planned.
  const { data: day } = await db.from("trip_days").insert({
    trip_id: tripId, date: "2027-05-14", day_number: 2, leg_id: leg?.id ?? null, start_time: "09:30", start_kind: "hotel",
  }).select("id").single();
  if (day) {
    const stops = DAY2.filter(s => placeIds[s.key]).map((s, i) => {
      const p = placeIds[s.key];
      return {
        day_id: day.id, place_id: p.id, name: p.name, address: p.address, lat: p.lat, lng: p.lng,
        duration_minutes: DEFAULT_MINUTES[p.category], duration_source: "default", stop_order: i,
        fixed_time: s.fixed ?? null, arrive_by: s.by ?? null,
      };
    });
    if (stops.length) await db.from("trip_stops").insert(stops);
  }

  return NextResponse.json({ tripId, report, hotel: hotel ? `${hotel.name}, ${hotel.address}` : null });
}
