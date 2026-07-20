// Lightweight geodesy helpers (no turf dependency — used in hot paths).

const R = 6371008.8; // mean Earth radius (m)
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres between [lon,lat] points. */
export function haversine(a: [number, number], b: [number, number]): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length in metres of a [lon,lat][] polyline. */
export function polylineLength(coords: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += haversine(coords[i - 1], coords[i]);
  return len;
}

export const KMH_PER_MS = 3.6;
export const msToKmh = (ms: number) => ms * KMH_PER_MS;
export const kmhToMs = (kmh: number) => kmh / KMH_PER_MS;
