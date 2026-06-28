// Journey session controller (SPEC §12): state machine, Geolocation watch,
// Screen Wake Lock, live speed/progress/ETA, downsampled track recording, and
// journey-record assembly with route-based per-class attribution (§13.3).

import { nearestPointOnLine } from '@turf/turf';
import type { LineString } from 'geojson';
import { haversine, polylineLength } from '../core/geo';
import { dynamicEta } from '../core/eta';
import type { EdgeClass } from '../core/classes';
import type { ClassSpan, Journey, RouteStep } from '../core/types';
import { Ema, effectiveSpeedKmh, fixFromPosition, STOP_THRESH_KMH, type Fix } from './speed';

export const OFFROUTE_M = 35; // perpendicular distance to flag off-route (§12.3)
export const OFFROUTE_T = 8; // seconds off-route before showing the banner
const TRACK_MIN_MOVE_M = 5; // downsample track: record when moved ≥ this

export type SessionState =
  | 'IDLE'
  | 'ROUTED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'FINISHING'
  | 'SAVED'
  | 'DISCARDED';

export interface RoutePlan {
  geometry: LineString;
  distance_m: number;
  plannedEta_s: number;
  steps: RouteStep[];
  preferenceP: number;
  startLabel: string;
  endLabel: string;
  startCoord: [number, number] | null;
  endCoord: [number, number] | null;
}

export interface NavMetrics {
  state: SessionState;
  mode: 'routed' | 'free';
  position: [number, number] | null;
  currentSpeed_kmh: number;
  avgMovingSpeed_kmh: number;
  maxSpeed_kmh: number;
  distanceCovered_m: number;
  elapsedTime_s: number;
  movingTime_s: number;
  remainingDistance_m: number;
  dynamicEta_s: number;
  offRoute: boolean;
  plannedDistance_m: number | null;
  plannedEta_s: number | null;
}

export interface SessionCallbacks {
  onState?: (state: SessionState) => void;
  onUpdate?: (m: NavMetrics) => void;
  onOffRoute?: (position: [number, number]) => void;
  onError?: (message: string) => void;
}

export class JourneySession {
  state: SessionState = 'IDLE';
  private mode: 'routed' | 'free' = 'free';
  private route: RoutePlan | null = null;
  private profileSpeed_kmh = 15;

  private watchId: number | null = null;
  private ticker: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  private prevFix: Fix | null = null;
  private lastTrackPoint: [number, number] | null = null;
  private position: [number, number] | null = null;

  private startedAt = 0;
  private endedAt = 0;
  private elapsedAccum = 0; // seconds accumulated before the current active span
  private resumeTs = 0; // ms when the current active span began

  private movingTime_s = 0;
  private movingDistance_m = 0;
  private distanceCovered_m = 0;
  private distanceAlong_m = 0;
  private maxSpeed_kmh = 0;
  private offRouteSince = 0;
  private offRoute = false;
  private offRouteFired = false;

  private readonly speedEma = new Ema();
  private currentSpeed_kmh = 0;
  private track: [number, number][] = [];

  constructor(private cb: SessionCallbacks = {}) {}

  // ---- planning ------------------------------------------------------------

  setRoute(plan: RoutePlan): void {
    this.route = plan;
    this.mode = 'routed';
    if (this.state === 'IDLE' || this.state === 'ROUTED') this.setState('ROUTED');
  }

  clearRoute(): void {
    this.route = null;
    if (this.state === 'ROUTED') this.setState('IDLE');
  }

  // ---- lifecycle (SPEC §12.2) ---------------------------------------------

  async start(opts: { free?: boolean; profileSpeed_kmh?: number } = {}): Promise<void> {
    if (this.state === 'ACTIVE') return;
    if (!('geolocation' in navigator)) {
      this.cb.onError?.('Geolocation is not available in this browser.');
      return;
    }
    this.mode = opts.free || !this.route ? 'free' : 'routed';
    this.profileSpeed_kmh = opts.profileSpeed_kmh ?? this.profileSpeed_kmh;
    this.resetCounters();
    this.startedAt = Date.now();
    this.resumeTs = this.startedAt;
    this.setState('ACTIVE');
    await this.acquireWakeLock();
    this.startWatch();
    this.startTicker();
  }

  pause(): void {
    if (this.state !== 'ACTIVE') return;
    this.elapsedAccum += (Date.now() - this.resumeTs) / 1000;
    this.stopWatch();
    this.prevFix = null;
    this.setState('PAUSED');
    this.emit();
  }

  resume(): void {
    if (this.state !== 'PAUSED') return;
    this.resumeTs = Date.now();
    this.setState('ACTIVE');
    this.startWatch();
  }

  /** Finish the session, returning the assembled journey record (not yet saved). */
  stop(): Journey | null {
    if (this.state !== 'ACTIVE' && this.state !== 'PAUSED') return null;
    if (this.state === 'ACTIVE') this.elapsedAccum += (Date.now() - this.resumeTs) / 1000;
    this.setState('FINISHING');
    this.teardown();
    this.endedAt = Date.now();
    const journey = this.buildJourney();
    this.setState('SAVED');
    return journey;
  }

  cancel(): void {
    if (this.state === 'IDLE' || this.state === 'ROUTED' || this.state === 'SAVED') return;
    this.teardown();
    this.setState('DISCARDED');
    this.resetCounters();
    this.setState(this.route ? 'ROUTED' : 'IDLE');
  }

  // ---- geolocation handling ------------------------------------------------

  private startWatch(): void {
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onFix(fixFromPosition(p)),
      (e) => this.cb.onError?.(geoErr(e)),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }

  private stopWatch(): void {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  private onFix(fix: Fix): void {
    if (this.state !== 'ACTIVE') return;
    const kmh = effectiveSpeedKmh(this.prevFix, fix);
    if (kmh === null) return; // rejected (accuracy / glitch)

    this.position = [fix.lon, fix.lat];
    this.currentSpeed_kmh = this.speedEma.push(kmh);
    if (kmh > this.maxSpeed_kmh) this.maxSpeed_kmh = kmh;

    if (this.prevFix) {
      const dt = (fix.timestamp - this.prevFix.timestamp) / 1000;
      const dist = haversine([this.prevFix.lon, this.prevFix.lat], [fix.lon, fix.lat]);
      this.distanceCovered_m += dist;
      if (kmh >= STOP_THRESH_KMH && dt > 0) {
        this.movingTime_s += dt;
        this.movingDistance_m += dist;
      }
    }
    this.recordTrack(fix);
    if (this.mode === 'routed' && this.route) this.updateProgress(fix);
    this.prevFix = fix;
    this.emit();
  }

  private recordTrack(fix: Fix): void {
    const pt: [number, number] = [fix.lon, fix.lat];
    if (!this.lastTrackPoint || haversine(this.lastTrackPoint, pt) >= TRACK_MIN_MOVE_M) {
      this.track.push(pt);
      this.lastTrackPoint = pt;
    }
  }

  private updateProgress(fix: Fix): void {
    const snapped = nearestPointOnLine(this.route!.geometry, [fix.lon, fix.lat], {
      units: 'meters',
    });
    const along = (snapped.properties.location as number) ?? 0;
    const offDist = (snapped.properties.dist as number) ?? 0;
    this.distanceAlong_m = along;

    if (offDist > OFFROUTE_M) {
      if (this.offRouteSince === 0) this.offRouteSince = fix.timestamp;
      else if (fix.timestamp - this.offRouteSince > OFFROUTE_T * 1000) {
        this.offRoute = true;
        if (!this.offRouteFired) {
          this.offRouteFired = true;
          this.cb.onOffRoute?.([fix.lon, fix.lat]);
        }
      }
    } else {
      this.offRouteSince = 0;
      this.offRoute = false;
      this.offRouteFired = false;
    }
  }

  // ---- derived metrics & ticker -------------------------------------------

  private get avgMovingSpeed_kmh(): number {
    if (this.movingTime_s <= 0) return 0;
    return this.movingDistance_m / 1000 / (this.movingTime_s / 3600);
  }

  private get elapsedTime_s(): number {
    const span = this.state === 'ACTIVE' ? (Date.now() - this.resumeTs) / 1000 : 0;
    return this.elapsedAccum + span;
  }

  private get remainingDistance_m(): number {
    if (this.mode !== 'routed' || !this.route) return 0;
    return Math.max(0, this.route.distance_m - this.distanceAlong_m);
  }

  private get dynamicEta_s(): number {
    if (this.mode !== 'routed') return 0;
    return dynamicEta(
      this.remainingDistance_m,
      this.avgMovingSpeed_kmh,
      this.profileSpeed_kmh,
      this.movingTime_s,
    );
  }

  private startTicker(): void {
    // 1 Hz refresh so elapsed time and dynamic ETA update without new fixes.
    this.ticker = self.setInterval(() => {
      if (this.state === 'ACTIVE') this.emit();
    }, 1000);
  }

  private emit(): void {
    this.cb.onUpdate?.({
      state: this.state,
      mode: this.mode,
      position: this.position,
      currentSpeed_kmh: this.state === 'ACTIVE' ? this.currentSpeed_kmh : 0,
      avgMovingSpeed_kmh: this.avgMovingSpeed_kmh,
      maxSpeed_kmh: this.maxSpeed_kmh,
      distanceCovered_m: this.distanceCovered_m,
      elapsedTime_s: this.elapsedTime_s,
      movingTime_s: this.movingTime_s,
      remainingDistance_m: this.remainingDistance_m,
      dynamicEta_s: this.dynamicEta_s,
      offRoute: this.offRoute,
      plannedDistance_m: this.route?.distance_m ?? null,
      plannedEta_s: this.route?.plannedEta_s ?? null,
    });
  }

  // ---- wake lock (SPEC §12.2) ---------------------------------------------

  private async acquireWakeLock(): Promise<void> {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', this.onVisibility);
      }
    } catch {
      /* wake lock optional — app still works without it */
    }
  }

  private onVisibility = async (): Promise<void> => {
    if (this.wakeLock === null && document.visibilityState === 'visible' && this.state === 'ACTIVE') {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch {
        /* ignore */
      }
    }
  };

  private releaseWakeLock(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }

  hasWakeLock(): boolean {
    return this.wakeLock !== null;
  }

  // ---- teardown / journey assembly ----------------------------------------

  private teardown(): void {
    this.stopWatch();
    if (this.ticker != null) {
      self.clearInterval(this.ticker);
      this.ticker = null;
    }
    this.releaseWakeLock();
  }

  private resetCounters(): void {
    this.prevFix = null;
    this.lastTrackPoint = null;
    this.position = null;
    this.elapsedAccum = 0;
    this.movingTime_s = 0;
    this.movingDistance_m = 0;
    this.distanceCovered_m = 0;
    this.distanceAlong_m = 0;
    this.maxSpeed_kmh = 0;
    this.currentSpeed_kmh = 0;
    this.offRouteSince = 0;
    this.offRoute = false;
    this.offRouteFired = false;
    this.track = [];
  }

  private buildJourney(): Journey {
    const actualDistance_m = this.distanceCovered_m || polylineLength(this.track);
    const classBreakdown = this.attributeClasses(actualDistance_m);
    return {
      id: cryptoId(),
      createdAt: this.endedAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      mode: this.mode,
      startLabel: this.route?.startLabel ?? 'Free ride',
      endLabel: this.route?.endLabel ?? '',
      startCoord: this.route?.startCoord ?? this.track[0] ?? null,
      endCoord: this.route?.endCoord ?? this.track[this.track.length - 1] ?? null,
      preferenceP: this.route?.preferenceP ?? 0,
      plannedDistance_m: this.mode === 'routed' ? (this.route?.distance_m ?? null) : null,
      plannedEta_s: this.mode === 'routed' ? (this.route?.plannedEta_s ?? null) : null,
      actualDistance_m,
      elapsedTime_s: this.elapsedTime_s,
      movingTime_s: this.movingTime_s,
      avgMovingSpeed_kmh: this.avgMovingSpeed_kmh,
      maxSpeed_kmh: this.maxSpeed_kmh,
      classBreakdown,
      track: this.track.slice(),
      routeGeometry: this.mode === 'routed' ? (this.route?.geometry ?? null) : null,
    };
  }

  // Route-based per-class attribution (SPEC §13.3): walk the planned steps up to
  // the rider's progress, proportioning moving time by covered distance.
  private attributeClasses(actualDistance_m: number): Partial<Record<EdgeClass, ClassSpan>> {
    const out: Partial<Record<EdgeClass, ClassSpan>> = {};
    if (this.mode === 'free' || !this.route) {
      out.path = { distance_m: actualDistance_m, movingTime_s: this.movingTime_s };
      return out;
    }
    const covered = Math.min(this.distanceAlong_m || actualDistance_m, this.route.distance_m);
    if (covered <= 0) return out;
    let remaining = covered;
    const perClassDist: Partial<Record<EdgeClass, number>> = {};
    for (const step of this.route.steps) {
      if (remaining <= 0) break;
      const d = Math.min(step.distance_m, remaining);
      perClassDist[step.cls] = (perClassDist[step.cls] ?? 0) + d;
      remaining -= d;
    }
    for (const [clsRaw, dist] of Object.entries(perClassDist)) {
      const cls = clsRaw as EdgeClass;
      out[cls] = {
        distance_m: dist!,
        movingTime_s: covered > 0 ? this.movingTime_s * (dist! / covered) : 0,
      };
    }
    return out;
  }

  private setState(s: SessionState): void {
    this.state = s;
    this.cb.onState?.(s);
  }
}

function cryptoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `j_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

function geoErr(e: GeolocationPositionError): string {
  if (e.code === e.PERMISSION_DENIED) return 'Location permission denied — live navigation needs it.';
  if (e.code === e.POSITION_UNAVAILABLE) return 'Location unavailable.';
  if (e.code === e.TIMEOUT) return 'Location request timed out.';
  return 'Location error.';
}
