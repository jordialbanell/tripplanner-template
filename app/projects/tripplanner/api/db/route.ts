// The only way the TripPlanner pages reach the database. The browser sends a small description
// of a query (see lib/trip/supabase.ts); this route checks who is asking (lib/trip/access.ts)
// and runs it with the server key, limited to what that person may see or change.
// - the owner: anything on the TripPlanner tables.
// - Edit link: read and change that one trip (and its places); can add places; can't delete trips or places.
// - View link / visitors: read only (visitors see the demo trip only).
import { NextRequest, NextResponse } from "next/server";
import { sharedDb } from "@/lib/shared-db";
import { getAccess, readableTrips, editableTrips, type Access } from "@/lib/trip/access";
import { WISHLIST_BOARD_ID } from "@/lib/trip/constants";

type Filter = { op: "eq" | "neq" | "in"; col: string; val: unknown };
interface Q {
  table: string;
  action: "select" | "insert" | "update" | "delete";
  columns?: string;
  values?: Record<string, unknown> | Record<string, unknown>[];
  filters?: Filter[];
  order?: { col: string; ascending?: boolean }[];
  limit?: number;
  single?: "single" | "maybe";
  returning?: string | null;
}

const TABLES = new Set([
  "trips", "trip_legs", "trip_days", "trip_stops", "trip_flights",
  "trip_included_places", "trip_excluded_places", "places",
]);
// Column that ties a row to a trip (or to a day, for stops).
const SCOPE_COL: Record<string, string> = {
  trips: "id", places: "id", trip_stops: "day_id",
  trip_legs: "trip_id", trip_days: "trip_id", trip_flights: "trip_id",
  trip_included_places: "trip_id", trip_excluded_places: "trip_id",
};

const COL_RE = /^[a-z_]+$/;
const SELECT_RE = /^[a-z_*,() ]{1,600}$/;

function bad(msg: string, status = 400) {
  return NextResponse.json({ data: null, error: { message: msg } }, { status });
}

function validate(q: Q): string | null {
  if (!q || typeof q !== "object") return "Bad request";
  if (!TABLES.has(q.table)) return "Unknown table";
  if (!["select", "insert", "update", "delete"].includes(q.action)) return "Unknown action";
  for (const s of [q.columns, q.returning]) if (s != null && !SELECT_RE.test(s)) return "Bad columns";
  for (const f of q.filters || []) {
    if (!["eq", "neq", "in"].includes(f.op) || !COL_RE.test(f.col)) return "Bad filter";
    if (f.op === "in" && !Array.isArray(f.val)) return "Bad filter";
  }
  for (const o of q.order || []) if (!COL_RE.test(o.col)) return "Bad order";
  const rows = q.values == null ? [] : Array.isArray(q.values) ? q.values : [q.values];
  for (const r of rows) {
    if (!r || typeof r !== "object") return "Bad values";
    for (const k of Object.keys(r)) if (!COL_RE.test(k)) return "Bad values";
  }
  if ((q.action === "insert" || q.action === "update") && rows.length === 0) return "No values";
  if ((q.action === "update" || q.action === "delete") && !(q.filters || []).length) return "Refusing to change every row";
  return null;
}

// ---------- scope helpers (non-owner only) ----------

async function daysOf(tripIds: string[]): Promise<string[]> {
  if (!tripIds.length) return [];
  const { data } = await sharedDb().from("trip_days").select("id").in("trip_id", tripIds);
  return (data || []).map(r => r.id as string);
}

// Places a trip shows: places in its countries plus ones added by hand. The demo trip shows
// only the places added to it, so the owner's own places never leak into it.
async function placesOf(tripIds: string[], demoIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!tripIds.length) return out;
  const db = sharedDb();
  const [inc, legs] = await Promise.all([
    db.from("trip_included_places").select("place_id").in("trip_id", tripIds),
    db.from("trip_legs").select("trip_id, country").in("trip_id", tripIds.filter(t => !demoIds.includes(t))),
  ]);
  (inc.data || []).forEach(r => out.add(r.place_id as string));
  const countries = Array.from(new Set((legs.data || []).map(r => r.country as string).filter(Boolean)));
  if (countries.length) {
    const { data } = await db.from("places").select("id").in("country", countries);
    (data || []).forEach(r => out.add(r.id as string));
  }
  return out;
}

function withScopeColumn(columns: string | undefined, col: string): string {
  const c = (columns || "*").trim();
  if (c === "*" || c.startsWith("*,") || c.split(",").map(s => s.trim()).includes(col)) return c;
  return `${c}, ${col}`;
}

// ---------- run ----------

async function run(q: Q, access: Access) {
  const db = sharedDb();
  const owner = access.owner;
  const scopeCol = SCOPE_COL[q.table];
  const read = Array.from(readableTrips(access));
  const edit = Array.from(editableTrips(access));
  const rows = q.values == null ? [] : Array.isArray(q.values) ? q.values : [q.values];

  // Work out the allowed ids for this table (non-owner).
  let allowed: string[] | null = null;     // null = no restriction (owner)
  let placeScope: Set<string> | null = null;
  if (!owner) {
    const trips = q.action === "select" ? read : edit;
    if (q.action !== "select" && !edit.length) return bad("View only", 403);
    if (q.table === "places") {
      placeScope = await placesOf(trips, access.demoTripIds);
    } else if (q.table === "trip_stops") {
      allowed = await daysOf(trips);
    } else {
      allowed = trips;
    }

    // Writes: extra rules per table.
    if (q.action === "delete" && (q.table === "trips" || q.table === "places")) return bad("Only the owner can delete this", 403);
    if (q.action === "insert" && q.table === "trips") return bad("Only the owner can create trips", 403);
    if (q.action === "insert" || q.action === "update") {
      for (const r of rows) {
        if ("is_demo" in r || "board_id" in r && q.table !== "places") return bad("Not allowed", 403);
        if (q.table !== "places" && q.table !== "trips" && scopeCol in r && !allowed!.includes(String(r[scopeCol]))) {
          return bad("Not your trip", 403);
        }
        if (q.action === "insert" && q.table !== "places" && !(scopeCol in r)) return bad("Missing trip", 403);
      }
      if (q.table === "places" && q.action === "insert") {
        for (const r of rows) r.board_id = WISHLIST_BOARD_ID;   // places always go in the one pool
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let b: any;
  switch (q.action) {
    case "select": b = db.from(q.table).select(owner ? (q.columns || "*") : withScopeColumn(q.columns, scopeCol)); break;
    case "insert": b = db.from(q.table).insert(q.values!); break;
    case "update": b = db.from(q.table).update(q.values!); break;
    case "delete": b = db.from(q.table).delete(); break;
  }
  for (const f of q.filters || []) {
    if (f.op === "eq") b = b.eq(f.col, f.val as never);
    else if (f.op === "neq") b = b.neq(f.col, f.val as never);
    else b = b.in(f.col, f.val as never[]);
  }
  // Keep non-owner reads and writes inside their trips.
  // (Inserts were already checked row by row above; filters don't apply to them.)
  if (!owner && allowed && q.action !== "insert") b = b.in(scopeCol, allowed.length ? allowed : ["00000000-0000-0000-0000-000000000000"]);
  if (!owner && placeScope && q.action === "update") {
    const ids = Array.from(placeScope);
    b = b.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }
  if (q.action !== "select" && q.returning !== undefined && q.returning !== null) {
    b = b.select(owner ? (q.returning || "*") : withScopeColumn(q.returning || "*", scopeCol));
  }
  for (const o of q.order || []) b = b.order(o.col, { ascending: o.ascending ?? true });
  if (q.limit) b = b.limit(Math.min(q.limit, 5000));

  // single()/maybeSingle() are applied after the scope filter below, so a hidden row
  // looks the same as a missing one.
  const res = await b;
  if (res.error) return NextResponse.json({ data: null, error: { message: res.error.message } });

  let data = res.data as Record<string, unknown>[] | null;
  if (!owner && q.table === "places" && placeScope && Array.isArray(data) && q.action === "select") {
    data = data.filter(r => placeScope!.has(String(r.id)));
  }
  if (q.single) {
    const list = Array.isArray(data) ? data : data ? [data] : [];
    if (list.length === 1) return NextResponse.json({ data: list[0], error: null });
    if (list.length === 0 && q.single === "maybe") return NextResponse.json({ data: null, error: null });
    return NextResponse.json({ data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } });
  }
  return NextResponse.json({ data: q.action === "select" || q.returning != null ? data : null, error: null });
}

export async function POST(req: NextRequest) {
  let q: Q;
  try { q = await req.json(); } catch { return bad("Invalid JSON"); }
  const problem = validate(q);
  if (problem) return bad(problem);
  try {
    return await run(q, await getAccess());
  } catch (e) {
    console.log("[trip-db]", q.table, q.action, e instanceof Error ? e.message : e);
    return bad("Database unavailable", 500);
  }
}
