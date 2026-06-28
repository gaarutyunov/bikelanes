// Personalized ETA model (SPEC §14). Pure functions, no DOM/worker deps.

import { EdgeClass, priorSpeedKmh, PRIOR_OVERALL_MEAN_KMH } from './classes';
import type { EtaSource, SpeedProfile } from './types';

// Confidence thresholds (SPEC §14.1, open question §20.8).
export const N_CLS_JOURNEYS = 3; // ≥3 journeys touching a class …
export const N_CLS_DISTANCE_M = 2000; // … or ≥2 km accumulated on it
export const N_OVR = 3; // ≥3 completed journeys for overall personalization

export interface EffectiveSpeed {
  kmh: number;
  source: EtaSource;
}

/** Effective realistic speed for a class given the rider's profile (§14.1). */
export function effectiveSpeed(cls: EdgeClass, profile: SpeedProfile | null): EffectiveSpeed {
  const prior = priorSpeedKmh(cls);
  if (!profile) return { kmh: prior, source: 'prior' };

  const pc = profile.perClass[cls];
  const confidentPerClass =
    pc && (pc.sampleCount >= N_CLS_JOURNEYS || pc.distance_m >= N_CLS_DISTANCE_M);
  if (confidentPerClass && pc) {
    return { kmh: pc.avgSpeed_kmh, source: 'personal-perclass' };
  }

  if (profile.overall.sampleJourneys >= N_OVR && profile.overall.avgSpeed_kmh > 0) {
    // Scale priors to the rider's pace, preserving the cycleway>road ordering.
    const scale = profile.overall.avgSpeed_kmh / PRIOR_OVERALL_MEAN_KMH;
    return { kmh: prior * scale, source: 'personal-overall' };
  }

  return { kmh: prior, source: 'prior' };
}

/**
 * Displayed ETA for a route given per-class distances (metres). No comfort
 * penalty (SPEC §14). Returns total seconds and the weakest etaSource used.
 */
export function routeEta(
  classBreakdown: Partial<Record<EdgeClass, number>>,
  profile: SpeedProfile | null,
): { eta_s: number; etaSource: EtaSource } {
  let eta = 0;
  // Report the *least* personalized source that contributed, so the UI never
  // overstates confidence.
  const rank: Record<EtaSource, number> = {
    'personal-perclass': 2,
    'personal-overall': 1,
    prior: 0,
  };
  let worst: EtaSource = 'personal-perclass';
  let any = false;
  for (const [cls, dist] of Object.entries(classBreakdown) as [EdgeClass, number][]) {
    if (!dist) continue;
    any = true;
    const es = effectiveSpeed(cls, profile);
    eta += dist / ((es.kmh * 1000) / 3600);
    if (rank[es.source] < rank[worst]) worst = es.source;
  }
  return { eta_s: eta, etaSource: any ? worst : 'prior' };
}

/** Dynamic ETA blend during a ride (SPEC §14.3). */
export function dynamicEta(
  remainingDistance_m: number,
  liveAvgMovingSpeed_kmh: number,
  profileSpeed_kmh: number,
  movingTime_s: number,
): number {
  const liveWeight = Math.min(0.8, movingTime_s / 600);
  const live = liveAvgMovingSpeed_kmh > 0 ? liveAvgMovingSpeed_kmh : profileSpeed_kmh;
  const blended = liveWeight * live + (1 - liveWeight) * profileSpeed_kmh;
  const speedMs = (blended * 1000) / 3600;
  if (speedMs <= 0) return 0;
  return remainingDistance_m / speedMs;
}
