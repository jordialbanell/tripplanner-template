// Client side of the weather strip: fetch per spot, keep the last answer for offline use.
export interface WeatherDay {
  date: string;          // YYYY-MM-DD, local to the spot
  code: number;          // WMO weather code
  hi: number;            // °C
  lo: number;            // °C
  rain: number | null;   // max chance of rain, %
  sunset: string | null; // HH:MM local time
}

const CACHE_KEY = 'tp-weather-v1';

function readCache(): Record<string, WeatherDay[]> {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}

function spotKey(lat: number, lng: number) { return `${lat.toFixed(2)},${lng.toFixed(2)}`; }

/** Daily weather for a spot. Falls back to the last saved answer when offline. */
export async function fetchWeather(lat: number, lng: number): Promise<WeatherDay[]> {
  const key = spotKey(lat, lng);
  try {
    const res = await fetch(`/projects/tripplanner/api/weather?lat=${lat}&lng=${lng}`);
    if (!res.ok) throw new Error(String(res.status));
    const { days } = await res.json() as { days: WeatherDay[] };
    try {
      const all = readCache();
      // Merge so days already gone from the forecast (yesterday's) stay known.
      const byDate = new Map((all[key] ?? []).map(d => [d.date, d]));
      for (const d of days) byDate.set(d.date, d);
      all[key] = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)).slice(-40);
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch { /* storage full or blocked */ }
    return days;
  } catch {
    try { return readCache()[key] ?? []; } catch { return []; }
  }
}

/** WMO weather code to an emoji and a short label. */
export function weatherLook(code: number): { emoji: string; label: string } {
  if (code === 0) return { emoji: '☀️', label: 'Clear' };
  if (code === 1) return { emoji: '🌤️', label: 'Mostly clear' };
  if (code === 2) return { emoji: '⛅', label: 'Partly cloudy' };
  if (code === 3) return { emoji: '☁️', label: 'Overcast' };
  if (code === 45 || code === 48) return { emoji: '🌫️', label: 'Fog' };
  if (code >= 51 && code <= 57) return { emoji: '🌦️', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { emoji: '🌧️', label: code >= 65 ? 'Heavy rain' : 'Rain' };
  if (code >= 71 && code <= 77) return { emoji: '🌨️', label: 'Snow' };
  if (code >= 80 && code <= 82) return { emoji: '🌦️', label: 'Showers' };
  if (code === 85 || code === 86) return { emoji: '🌨️', label: 'Snow showers' };
  if (code >= 95) return { emoji: '⛈️', label: 'Thunderstorm' };
  return { emoji: '🌡️', label: 'Weather' };
}
