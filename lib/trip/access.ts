// Server-only: who may read or change which TripPlanner trip.
//
// Three kinds of caller:
// - the owner (owner cookie from lib/owner.ts): everything.
// - Someone holding a share link: one trip each, "view" or "edit". The link's code lives in an
//   httpOnly cookie (set by /projects/tripplanner/s/<code>); only its SHA-256 is stored, and every
//   request re-checks it against trip_shares, so switching a link off works immediately.
// - Everyone else: read-only access to the demo trip(s) (trips.is_demo = true).
//
// Nothing here trusts the browser: the client never holds a database key.
import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isOwner } from "@/lib/owner";
import { sharedDb } from "@/lib/shared-db";

export const SHARE_COOKIE = "ja_tshare";
export const SHARE_COOKIE_PATH = "/projects/tripplanner";
export const DAILY_PAID_CAP = 60;
const MAX_TOKENS = 10;

export type Role = "view" | "edit";

export interface Access {
  owner: boolean;
  shares: { id: string; tripId: string; role: Role }[];
  demoTripIds: string[];
}

// ---------- tokens ----------

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const looksLikeToken = (t: string) => TOKEN_RE.test(t);

// The raw code is also stored encrypted so the owner can copy a link again later.
function key() {
  const s = process.env.PROJECTS_OWNER_SECRET;
  if (!s) throw new Error("PROJECTS_OWNER_SECRET not set");
  return createHash("sha256").update(`trip-share:${s}`).digest();
}
export function encryptToken(t: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(t, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString("base64url")).join(".");
}
export function decryptToken(enc: string): string | null {
  try {
    const [iv, tag, body] = enc.split(".").map(p => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export async function cookieTokens(): Promise<string[]> {
  const raw = (await cookies()).get(SHARE_COOKIE)?.value || "";
  return raw.split(".").filter(looksLikeToken).slice(0, MAX_TOKENS);
}

export function joinTokens(existing: string[], add: string): string {
  return [add, ...existing.filter(t => t !== add)].slice(0, MAX_TOKENS).join(".");
}

// ---------- who is asking ----------

const missingTable = (msg?: string) => !!msg && /does not exist|schema cache|Could not find/i.test(msg);

export async function getAccess(): Promise<Access> {
  await connection(); // depends on who's asking: never pre-rendered or cached
  const db = sharedDb();
  const owner = await isOwner();

  let demoTripIds: string[] = [];
  const demo = await db.from("trips").select("id").eq("is_demo", true);
  if (!demo.error) demoTripIds = (demo.data || []).map(r => r.id as string);

  let shares: Access["shares"] = [];
  const tokens = await cookieTokens();
  if (tokens.length) {
    const { data, error } = await db.from("trip_shares")
      .select("id, trip_id, role, revoked_at, expires_at")
      .in("token_hash", tokens.map(hashToken));
    if (error && !missingTable(error.message)) console.log("[trip-access] shares", error.message);
    const now = Date.now();
    shares = (data || [])
      .filter(r => !r.revoked_at && (!r.expires_at || new Date(r.expires_at as string).getTime() > now))
      .map(r => ({ id: r.id as string, tripId: r.trip_id as string, role: r.role === "edit" ? "edit" : "view" }));
  }
  return { owner, shares, demoTripIds };
}

export function readableTrips(a: Access): Set<string> {
  return new Set([...a.demoTripIds, ...a.shares.map(s => s.tripId)]);
}
export function editableTrips(a: Access): Set<string> {
  return new Set(a.shares.filter(s => s.role === "edit").map(s => s.tripId));
}
export const canEditTrip = (a: Access, tripId: string) => a.owner || editableTrips(a).has(tripId);
export const canReadTrip = (a: Access, tripId: string) => a.owner || readableTrips(a).has(tripId);

// ---------- paid features (AI, Google) ----------

export type PaidCheck = { ok: true } | { ok: false; status: number; error: string };

// Rough cost of one call per feature, in US dollars, at list price AFTER the free monthly
// allowances (so real bills are usually lower). Checked 3 Nov 2026 against
// developers.google.com/maps/billing-and-pricing/pricing and Anthropic's pricing page:
// Places Text Search Pro $32/1k, Place Details Enterprise + Atmosphere $25/1k, Places photo $7/1k,
// Compute Routes Essentials $5/1k (walk, transit) + Pro $10/1k (drive with traffic),
// Distance Matrix $5/1k, Claude web search $10/1k searches (up to 3 per call) plus tokens.
// Model token costs, Apify and AssemblyAI are rough allowances, not checked prices.
export const PAID_FEATURES = {
  places: { label: 'Place search', usd: 0.035 },
  hotel: { label: 'Hotel pin', usd: 0.035 },
  routes: { label: 'Travel times', usd: 0.02 },
  travel: { label: 'Travel times (old)', usd: 0.005 },
  research: { label: 'Research', usd: 0.06 },
  chat: { label: 'Trip chat', usd: 0.06 },
  flights: { label: 'Flight lookup', usd: 0.06 },
  describe: { label: 'Descriptions', usd: 0.03 },   // per place
  import: { label: 'List import', usd: 0.035 },     // per item, plus PAID_IMPORT_BASE
  extract: { label: 'TikTok / Instagram', usd: 0.1 },
  draft: { label: 'AI day drafting', usd: 0.005 },
  photo: { label: 'Place photos', usd: 0.03 },      // per place: details (photos) + one photo, sometimes a search
} as const;
export type PaidFeature = keyof typeof PAID_FEATURES;
const PAID_IMPORT_BASE = 0.03;

export function paidCost(feature: PaidFeature, count = 1): number {
  const per = PAID_FEATURES[feature].usd * Math.max(1, count);
  return Math.round((feature === 'import' ? per + PAID_IMPORT_BASE : per) * 100000) / 100000;
}

const BUDGET_MSG = "This link has used its spending limit. Ask the trip owner to raise it.";
const DAILY_MSG = "Daily limit reached for this link, try again tomorrow.";

// Owner: always. Edit link: up to DAILY_PAID_CAP calls a day per link, and within the link's
// spending limit if it has one. Everyone else: no.
// Pass a tripId when the request is about one trip, so the right link is charged.
export async function chargePaid(a: Access, tripId: string | null | undefined, feature: PaidFeature, count = 1): Promise<PaidCheck> {
  if (a.owner) return { ok: true };
  const edits = a.shares.filter(s => s.role === "edit" && (!tripId || s.tripId === tripId));
  if (edits.length === 0) {
    return { ok: false, status: 403, error: "This needs an edit link or the owner's sign-in." };
  }
  const usd = paidCost(feature, count);
  let lastRefusal: "daily" | "budget" = "daily";
  for (const s of edits) {
    const v2 = await sharedDb().rpc("trip_share_charge_v2", { sid: s.id, cap: DAILY_PAID_CAP, feature, usd });
    let result: string | null = null;
    if (!v2.error) result = String(v2.data);
    else if (missingTable(v2.error.message)) {
      // 019_trip_share_spend.sql not run yet: count calls only, like before.
      const v1 = await sharedDb().rpc("trip_share_charge", { sid: s.id, cap: DAILY_PAID_CAP });
      if (v1.error) {
        console.log("[trip-access] charge", v1.error.message);
        return { ok: false, status: 503, error: "Couldn't check today's limit. Try again later." };
      }
      result = v1.data === true ? "ok" : "daily";
    } else {
      console.log("[trip-access] charge", v2.error.message);
      return { ok: false, status: 503, error: "Couldn't check today's limit. Try again later." };
    }
    if (result === "ok") return { ok: true };
    if (result === "budget") lastRefusal = "budget";
  }
  return { ok: false, status: 429, error: lastRefusal === "budget" ? BUDGET_MSG : DAILY_MSG };
}

// One call for API routes: work out access and charge it, or return the response to send.
// count = how many items the call covers (places to describe, list items to import).
export async function requirePaid(feature: PaidFeature, tripId?: string | null, count = 1): Promise<Response | null> {
  await connection(); // outside the try: Next uses this to mark the route as per-request
  try {
    const check = await chargePaid(await getAccess(), tripId, feature, count);
    if (check.ok) return null;
    return Response.json({ error: check.error }, { status: check.status });
  } catch (e) {
    console.log("[trip-access] requirePaid", e instanceof Error ? e.message : e);
    return Response.json({ error: "Not allowed" }, { status: 403 });
  }
}

export async function requireOwner(): Promise<Response | null> {
  await connection();
  return (await isOwner()) ? null : Response.json({ error: "Only the owner can do this." }, { status: 403 });
}
