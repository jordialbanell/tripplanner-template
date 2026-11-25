// What the current visitor can do, for showing or hiding buttons. The server still checks
// every request on its own (api/db and the paid routes), so this is only for the UI.
import { NextResponse } from "next/server";
import { getAccess, readableTrips, editableTrips } from "@/lib/trip/access";

export async function GET() {
  try {
    const a = await getAccess();
    return NextResponse.json({
      owner: a.owner,
      canEdit: Array.from(editableTrips(a)),
      canView: Array.from(readableTrips(a)),
      demo: a.demoTripIds,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ owner: false, canEdit: [], canView: [], demo: [] });
  }
}
