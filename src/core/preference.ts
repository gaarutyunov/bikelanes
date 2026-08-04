// Preference model — the slider (SPEC §7.3).
// A per-class comfort penalty multiplies *time* to form the routing cost.
// IMPORTANT: this penalty affects path selection ONLY, never the displayed ETA.

import { EdgeClass, priorSpeedKmh } from './classes';

export const PENALTY_MAX = 6.0; // tunable (SPEC §7.3 / open question §20.2)
export const DEFAULT_PREFERENCE = 0.35; // default slider value (SPEC §7.3)

/**
 * Per-class discomfort, 0 = ideal (segregated cycle track) … 1 = a main road.
 * Values above 1 are surfaces to avoid outright.
 *
 * This replaces the original binary bike/road split, which gave every "bike"
 * class the same zero penalty and every road the same flat one. That model made
 * a pavement as attractive as a cycle track and a four-lane primary as
 * attractive as a quiet residential street, which is why routes ignored the
 * lane network (#5).
 */
export const COMFORT: Record<EdgeClass, number> = {
  cycleway: 0.0, // segregated track — what the app exists to find
  cycle_street: 0.1,
  cycle_lane: 0.15, // painted lane alongside traffic
  living_street: 0.4,
  residential: 0.55,
  path: 0.6, // shared path where bikes are explicitly allowed
  shared_lane: 0.6, // sharrow — better than the bare main road it is painted on
  tertiary: 0.7,
  connector: 0.4, // synthetic snap link — same penalty as before (1 + (1-p)·2)
  link: 0.85,
  secondary: 0.9,
  primary: 1.0,
  footway: 1.3, // pavement / pedestrian street — rideable only as a last resort
};

/** Comfort penalty for an edge class at preference `p ∈ [0,1]`. */
export function penalty(cls: EdgeClass, p: number): number {
  return 1 + (1 - p) * (PENALTY_MAX - 1) * COMFORT[cls];
}

/**
 * Routing cost for an edge (SPEC §7.3): prior-time × comfort penalty.
 * Uses prior speeds only — routing cost is independent of personal history.
 * `len` is in metres; returned cost is in penalty-weighted seconds.
 */
export function routingCost(len: number, cls: EdgeClass, p: number): number {
  const speedMs = (priorSpeedKmh(cls) * 1000) / 3600;
  const time = len / speedMs;
  return time * penalty(cls, p);
}
