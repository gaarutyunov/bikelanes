// Incremental speed-profile maintenance (SPEC §13.2, §14.1). Pure functions:
// updated on each journey save so ETA never rescans all journeys.

import type { EdgeClass } from '../core/classes';
import type { Journey, SpeedProfile, PerClassStat } from '../core/types';

// Distance scale (m) controlling the distance-weighted EMA: a journey this long
// contributes ~half the new blend (SPEC §14.1 "distance-weighted EMA").
const EMA_SCALE_M = 8000;

export function emptyProfile(now: number): SpeedProfile {
  return {
    overall: { avgSpeed_kmh: 0, totalDistance_m: 0, totalMovingTime_s: 0, sampleJourneys: 0 },
    perClass: {},
    updatedAt: now,
  };
}

function ema(prev: number, sample: number, distance_m: number): number {
  if (prev <= 0) return sample;
  const alpha = distance_m / (distance_m + EMA_SCALE_M);
  return alpha * sample + (1 - alpha) * prev;
}

function speedKmh(distance_m: number, movingTime_s: number): number {
  if (movingTime_s <= 0) return 0;
  return distance_m / 1000 / (movingTime_s / 3600);
}

export function updateProfile(profile: SpeedProfile, j: Journey, now: number): SpeedProfile {
  const next: SpeedProfile = {
    overall: { ...profile.overall },
    perClass: { ...profile.perClass },
    updatedAt: now,
  };

  const jSpeed = j.avgMovingSpeed_kmh > 0 ? j.avgMovingSpeed_kmh : speedKmh(j.actualDistance_m, j.movingTime_s);
  if (j.movingTime_s > 0 && j.actualDistance_m > 0) {
    next.overall.avgSpeed_kmh = ema(profile.overall.avgSpeed_kmh, jSpeed, j.actualDistance_m);
    next.overall.totalDistance_m += j.actualDistance_m;
    next.overall.totalMovingTime_s += j.movingTime_s;
    next.overall.sampleJourneys += 1;
  }

  for (const [clsRaw, span] of Object.entries(j.classBreakdown)) {
    const cls = clsRaw as EdgeClass;
    if (!span || span.distance_m <= 0 || span.movingTime_s <= 0) continue;
    const sample = speedKmh(span.distance_m, span.movingTime_s);
    const prev: PerClassStat = next.perClass[cls] ?? {
      avgSpeed_kmh: 0,
      distance_m: 0,
      movingTime_s: 0,
      sampleCount: 0,
    };
    next.perClass[cls] = {
      avgSpeed_kmh: ema(prev.avgSpeed_kmh, sample, span.distance_m),
      distance_m: prev.distance_m + span.distance_m,
      movingTime_s: prev.movingTime_s + span.movingTime_s,
      sampleCount: prev.sampleCount + 1,
    };
  }

  return next;
}

/** Rebuild a profile from scratch (used after history import / clear). */
export function rebuildProfile(journeys: Journey[], now: number): SpeedProfile {
  let p = emptyProfile(now);
  // Oldest first so the EMA recency ordering matches the original saves.
  const ordered = journeys.slice().sort((a, b) => a.createdAt - b.createdAt);
  for (const j of ordered) p = updateProfile(p, j, now);
  return p;
}
