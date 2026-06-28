// Preference model — the slider (SPEC §7.3).
// A per-class comfort penalty multiplies *time* to form the routing cost.
// IMPORTANT: this penalty affects path selection ONLY, never the displayed ETA.

import { EdgeClass, isBike, priorSpeedKmh } from './classes';

export const PENALTY_MAX = 4.0; // tunable (SPEC §7.3 / open question §20.2)
export const DEFAULT_PREFERENCE = 0.35; // default slider value (SPEC §7.3)

/** Comfort penalty for an edge class at preference `p ∈ [0,1]`. */
export function penalty(cls: EdgeClass, p: number): number {
  if (isBike(cls)) return 1.0;
  if (cls === 'connector') return 1 + (1 - p) * 2.0;
  // roadPenalty
  return 1 + (1 - p) * (PENALTY_MAX - 1);
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
