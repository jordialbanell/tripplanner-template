// Opening a share link: /projects/tripplanner/s/<code>.
// If the code is a live link, it's kept in an httpOnly cookie (the browser's scripts can't read it)
// and the person lands on that trip. A switched-off or unknown link lands on the TripPlanner home.
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sharedDb } from "@/lib/shared-db";
import {
  SHARE_COOKIE, SHARE_COOKIE_PATH, cookieTokens, hashToken, joinTokens, looksLikeToken,
} from "@/lib/trip/access";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const home = new URL("/projects/tripplanner?link=off", req.url);
  if (!looksLikeToken(token)) return NextResponse.redirect(home);

  const { data } = await sharedDb().from("trip_shares")
    .select("trip_id, revoked_at, expires_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  const live = data && !data.revoked_at && (!data.expires_at || new Date(data.expires_at).getTime() > Date.now());
  if (!live) return NextResponse.redirect(home);

  (await cookies()).set(SHARE_COOKIE, joinTokens(await cookieTokens(), token), {
    httpOnly: true, secure: true, sameSite: "lax", path: SHARE_COOKIE_PATH, maxAge: 180 * 86_400,
  });
  // Shared links open on the schedule: that is what people are sent to look at.
  return NextResponse.redirect(new URL(`/projects/tripplanner/trip/${data.trip_id}#schedule`, req.url));
}
