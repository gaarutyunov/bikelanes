// Live speed measurement: filtering, smoothing & effective speed (SPEC §12.1).

import { haversine, msToKmh } from '../core/geo';

export const ACC_MAX = 30; // m — reject fixes worse than this (§12.1)
export const BIKE_MAX_KMH = 60; // reject speeds above this as GPS glitches
export const STOP_THRESH_KMH = 1.0; // below this counts as stopped
export const EMA_ALPHA = 0.3; // smoothing for displayed current speed

export interface Fix {
  lon: number;
  lat: number;
  accuracy: number;
  timestamp: number; // ms
  speed: number | null; // m/s from device, may be null
  heading: number | null;
}

export function fixFromPosition(p: GeolocationPosition): Fix {
  return {
    lon: p.coords.longitude,
    lat: p.coords.latitude,
    accuracy: p.coords.accuracy ?? Infinity,
    timestamp: p.timestamp,
    speed: p.coords.speed != null && !Number.isNaN(p.coords.speed) ? p.coords.speed : null,
    heading: p.coords.heading ?? null,
  };
}

/**
 * Effective speed (km/h) for a fix, or null if it should be rejected.
 * Prefers the device speed when accurate; otherwise derives from displacement.
 */
export function effectiveSpeedKmh(prev: Fix | null, cur: Fix): number | null {
  if (cur.accuracy > ACC_MAX) return null;

  let kmh: number;
  if (cur.speed != null && cur.accuracy <= ACC_MAX) {
    kmh = msToKmh(cur.speed);
  } else if (prev) {
    const dt = (cur.timestamp - prev.timestamp) / 1000;
    if (dt <= 0 || dt > 30) return null;
    const dist = haversine([prev.lon, prev.lat], [cur.lon, cur.lat]);
    kmh = msToKmh(dist / dt);
  } else {
    return 0;
  }

  if (kmh > BIKE_MAX_KMH) return null; // GPS glitch
  return kmh;
}

export class Ema {
  private value = 0;
  private seeded = false;
  constructor(private alpha = EMA_ALPHA) {}
  push(sample: number): number {
    if (!this.seeded) {
      this.value = sample;
      this.seeded = true;
    } else {
      this.value = this.alpha * sample + (1 - this.alpha) * this.value;
    }
    return this.value;
  }
  get(): number {
    return this.value;
  }
}
