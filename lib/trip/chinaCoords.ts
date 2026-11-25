// Google returns mainland-China coordinates on China's official GCJ-02 grid, about 300-700 m
// off the standard WGS-84 grid that Mapbox tiles and phone GPS use. Without converting,
// places by the Bund land in the Huangpu River. Hong Kong, Macau and Taiwan use WGS-84.
// Standard GCJ-02 inverse (accurate to a few metres).

const A = 6378245.0;
const EE = 0.00669342162296594323;

function inBox(lat: number, lng: number, s: number, n: number, w: number, e: number) {
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

export function inMainlandChina(lat: number, lng: number): boolean {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return false;
  if (inBox(lat, lng, 22.15, 22.57, 113.82, 114.45)) return false; // Hong Kong
  if (inBox(lat, lng, 22.10, 22.22, 113.52, 113.61)) return false; // Macau
  if (inBox(lat, lng, 21.8, 25.4, 119.9, 122.1)) return false;    // Taiwan
  // Rough outline: drop the empty corners the rectangle above takes in (Korea, Japan, SE Asia).
  if (lat < 20 && lng > 112) return false;   // Philippines, South China Sea
  if (lng > 124.5 && lat < 40) return false;  // Korea, Japan
  return true;
}

function tLat(x: number, y: number) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return r;
}
function tLng(x: number, y: number) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return r;
}
function offset(lat: number, lng: number): [number, number] {
  const dLat0 = tLat(lng - 105, lat - 35);
  const dLng0 = tLng(lng - 105, lat - 35);
  const rad = lat / 180 * Math.PI;
  let m = Math.sin(rad);
  m = 1 - EE * m * m;
  const sm = Math.sqrt(m);
  return [
    (dLat0 * 180) / ((A * (1 - EE)) / (m * sm) * Math.PI),
    (dLng0 * 180) / (A / sm * Math.cos(rad) * Math.PI),
  ];
}

// GCJ-02 -> WGS-84, iterated so the error is under a metre. Outside mainland China: unchanged.
export function toWgs84(lat: number, lng: number): { lat: number; lng: number } {
  if (!inMainlandChina(lat, lng)) return { lat, lng };
  let wLat = lat, wLng = lng;
  for (let i = 0; i < 3; i++) {
    const [dLat, dLng] = offset(wLat, wLng);
    wLat = lat - dLat;
    wLng = lng - dLng;
  }
  return { lat: wLat, lng: wLng };
}

// WGS-84 -> GCJ-02 (for comparing your phone's GPS with stored places).
export function toGcj02(lat: number, lng: number): { lat: number; lng: number } {
  if (!inMainlandChina(lat, lng)) return { lat, lng };
  const [dLat, dLng] = offset(lat, lng);
  return { lat: lat + dLat, lng: lng + dLng };
}
