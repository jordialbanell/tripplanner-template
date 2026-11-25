// Daily weather + sunset for a spot, from Open-Meteo (free, no key). Proxied through the app so it
// works wherever the app itself loads (open-meteo.com may be slow or blocked in mainland China).
// Open-Meteo forecasts 16 days ahead; days further out simply come back missing.
import { NextResponse, connection } from "next/server";
import type { WeatherDay } from "@/lib/trip/weather";

export async function GET(req: Request) {
  await connection();
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: "Bad position" }, { status: 400 });
  }
  const api = new URL("https://api.open-meteo.com/v1/forecast");
  api.searchParams.set("latitude", lat.toFixed(3));
  api.searchParams.set("longitude", lng.toFixed(3));
  api.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset");
  api.searchParams.set("timezone", "auto");
  api.searchParams.set("forecast_days", "16");
  api.searchParams.set("past_days", "1");
  try {
    const res = await fetch(api, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ error: `Weather service ${res.status}` }, { status: 502 });
    const j = await res.json() as {
      daily?: {
        time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[];
        precipitation_probability_max?: (number | null)[]; sunset?: string[];
      };
    };
    const d = j.daily;
    if (!d?.time) return NextResponse.json({ days: [] });
    const days: WeatherDay[] = d.time.map((date, i) => ({
      date,
      code: d.weather_code[i],
      hi: Math.round(d.temperature_2m_max[i]),
      lo: Math.round(d.temperature_2m_min[i]),
      rain: d.precipitation_probability_max?.[i] ?? null,
      sunset: d.sunset?.[i]?.slice(11, 16) || null, // "2026-11-13T16:59" -> "16:59", already local
    }));
    return NextResponse.json({ days }, { headers: { "Cache-Control": "public, max-age=1800" } });
  } catch {
    return NextResponse.json({ error: "Weather service unreachable" }, { status: 502 });
  }
}
