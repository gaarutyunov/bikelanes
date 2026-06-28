// Shared types used across the app, workers, history and pipeline.

import type { EdgeClass } from './classes';
import type { LineString } from 'geojson';

export type EtaSource = 'personal-perclass' | 'personal-overall' | 'prior';

// ---- Manifest (SPEC §6 Stage 6 / §8) --------------------------------------

export interface ArtifactEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  schema: number;
  buildDate: string;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  attribution: string[];
  // basemap is optional: sample builds ship GeoJSON display layers instead of
  // PMTiles (which require GDAL/tippecanoe at build time, SPEC §6 Stage 5).
  basemap: { kind: 'pmtiles' | 'none'; path?: string };
  bikelanes: { kind: 'pmtiles' | 'geojson'; path: string };
  artifacts: Record<string, ArtifactEntry>;
  search: { records: number };
}

// ---- Routing (SPEC §7.6) ---------------------------------------------------

export interface RouteRequest {
  start: [number, number]; // lon, lat
  end: [number, number]; // lon, lat
  p: number; // preference 0..1
  profile: SpeedProfile | null; // for personalized ETA (§14)
}

export interface RouteResult {
  geometry: LineString;
  distance_m: number;
  eta_s: number;
  etaSource: EtaSource;
  steps: RouteStep[];
  classBreakdown: Partial<Record<EdgeClass, number>>; // distance per class
  usedRoadShare: number; // 0..1 fraction of distance on non-bike edges
}

export interface RouteStep {
  text: string;
  distance_m: number;
  cls: EdgeClass;
}

// ---- Speed profile (SPEC §13.2 / §14) -------------------------------------

export interface PerClassStat {
  avgSpeed_kmh: number;
  distance_m: number;
  movingTime_s: number;
  sampleCount: number;
}

export interface SpeedProfile {
  overall: {
    avgSpeed_kmh: number;
    totalDistance_m: number;
    totalMovingTime_s: number;
    sampleJourneys: number;
  };
  perClass: Partial<Record<EdgeClass, PerClassStat>>;
  updatedAt: number;
}

// ---- Journey records (SPEC §13.2) -----------------------------------------

export type JourneyMode = 'routed' | 'free';

export interface ClassSpan {
  distance_m: number;
  movingTime_s: number;
}

export interface Journey {
  id: string;
  createdAt: number;
  startedAt: number;
  endedAt: number;
  mode: JourneyMode;
  startLabel: string;
  endLabel: string;
  startCoord: [number, number] | null;
  endCoord: [number, number] | null;
  preferenceP: number;
  plannedDistance_m: number | null;
  plannedEta_s: number | null;
  actualDistance_m: number;
  elapsedTime_s: number;
  movingTime_s: number;
  avgMovingSpeed_kmh: number;
  maxSpeed_kmh: number;
  classBreakdown: Partial<Record<EdgeClass, ClassSpan>>;
  track: [number, number][]; // simplified polyline [lon,lat]
  routeGeometry: LineString | null;
}
