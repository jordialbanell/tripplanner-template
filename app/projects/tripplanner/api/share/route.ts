// the owner's share links for one trip. Owner only.
// GET  ?tripId=...                 list links (live ones include their URL to copy again)
// POST { tripId, role, days? }     create a new link (view or edit), optionally ending after N days
// PATCH { id, budgetEur }          change a link's spending limit (null = no limit)
// DELETE { id }                    switch a link off for good (a new link is a new code)
// Spend figures are estimates (see PAID_FEATURES in lib/trip/access.ts), stored in USD,
// shown in euros at the ECB daily rate.
import { NextRequest, NextResponse } from "next/server";
import { sharedDb } from "@/lib/shared-db";
import { DAILY_PAID_CAP, PAID_FEATURES, decryptToken, encryptToken, hashToken, newToken, requireOwner } from "@/lib/trip/access";
import { toEuroRate } from "@/lib/trip/money";

const UUID = /^[0-9a-f-]{36}$/i;
const sgToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });

// Budget arrives in euros from the UI; stored in USD like the spend.
async function budgetUsd(eur: unknown): Promise<number | null | undefined> {
  if (eur === null) return null;
  if (typeof eur !== "number" || !(eur > 0) || eur > 1000) return undefined;
  const rate = await toEuroRate("USD");
  return rate ? Math.round((eur / rate) * 10000) / 10000 : undefined;
}

const linkUrl = (req: NextRequest, token: string) => new URL(`/projects/tripplanner/s/${token}`, req.url).toString();

export async function GET(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;
  const tripId = req.nextUrl.searchParams.get("tripId") || "";
  if (!UUID.test(tripId)) return NextResponse.json({ error: "tripId required" }, { status: 400 });
  const { data, error } = await sharedDb().from("trip_shares")
    .select("*")
    .eq("trip_id", tripId).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message, setupNeeded: true }, { status: 500 });

  // Spend per link. Older databases (019 not run) have no est_usd / features: counts only.
  const ids = (data || []).filter(r => r.role === "edit").map(r => r.id as string);
  const spend = new Map<string, { today: number; total: number; usd: number; features: Record<string, number> }>();
  let spendTracked = true;
  if (ids.length) {
    const u = await sharedDb().from("trip_share_usage").select("*").in("share_id", ids);
    const today = sgToday();
    for (const r of u.data || []) {
      if (!("est_usd" in r)) spendTracked = false;
      const sp = spend.get(r.share_id) || { today: 0, total: 0, usd: 0, features: {} };
      const calls = Number(r.calls) || 0;
      sp.total += calls;
      if (String(r.day) === today) sp.today += calls;
      sp.usd += Number(r.est_usd) || 0;
      for (const [k, v] of Object.entries((r.features || {}) as Record<string, number>)) sp.features[k] = (sp.features[k] || 0) + (Number(v) || 0);
      spend.set(r.share_id, sp);
    }
  }
  const eurPerUsd = await toEuroRate("USD");
  const now = Date.now();
  const links = (data || []).map(r => {
    const live = !r.revoked_at && (!r.expires_at || new Date(r.expires_at).getTime() > now);
    const token = live ? decryptToken(r.token_enc as string) : null;
    return {
      id: r.id, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at,
      live, url: token ? linkUrl(req, token) : null,
      budgetUsd: r.budget_usd == null ? null : Number(r.budget_usd),
      usage: r.role === "edit" ? (spend.get(r.id) || { today: 0, total: 0, usd: 0, features: {} }) : null,
    };
  });
  const labels = Object.fromEntries(Object.entries(PAID_FEATURES).map(([k, v]) => [k, v.label]));
  return NextResponse.json({ links, eurPerUsd, dailyCap: DAILY_PAID_CAP, labels, spendTracked });
}

export async function POST(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;
  let body: { tripId?: string; role?: string; days?: number; budgetEur?: number | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const tripId = body.tripId || "";
  const role = body.role === "edit" ? "edit" : body.role === "view" ? "view" : null;
  if (!UUID.test(tripId) || !role) return NextResponse.json({ error: "tripId and role required" }, { status: 400 });
  const days = typeof body.days === "number" && body.days > 0 && body.days <= 365 ? Math.round(body.days) : null;

  let budget: number | null = null;
  if (role === "edit" && body.budgetEur != null) {
    const b = await budgetUsd(body.budgetEur);
    if (b === undefined) return NextResponse.json({ error: "Couldn't set that spending limit. Try again." }, { status: 400 });
    budget = b;
  }

  const token = newToken();
  const row: Record<string, unknown> = {
    trip_id: tripId, role,
    token_hash: hashToken(token), token_enc: encryptToken(token),
    expires_at: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
  };
  if (budget !== null) row.budget_usd = budget;
  const { data, error } = await sharedDb().from("trip_shares").insert(row).select("id, role, created_at, expires_at").single();
  if (error && budget !== null && /budget_usd/.test(error.message)) {
    return NextResponse.json({ error: "Spending limits need a one-time database setup (supabase/019_trip_share_spend.sql)." }, { status: 500 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ link: { ...data, live: true, url: linkUrl(req, token) } });
}

export async function PATCH(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;
  let body: { id?: string; budgetEur?: number | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.id || !UUID.test(body.id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const budget = await budgetUsd(body.budgetEur ?? null);
  if (budget === undefined) return NextResponse.json({ error: "Couldn't set that spending limit. Try again." }, { status: 400 });
  const { error } = await sharedDb().from("trip_shares")
    .update({ budget_usd: budget }).eq("id", body.id).eq("role", "edit").is("revoked_at", null);
  if (error) {
    const setup = /budget_usd/.test(error.message);
    return NextResponse.json({ error: setup ? "Spending limits need a one-time database setup (supabase/019_trip_share_spend.sql)." : error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;
  let body: { id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.id || !UUID.test(body.id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await sharedDb().from("trip_shares")
    .update({ revoked_at: new Date().toISOString() }).eq("id", body.id).is("revoked_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
