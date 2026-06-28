// BikeNav Málaga — app entry point. Wires map, workers, search, slider, import,
// route panel, navigation HUD and history panel together. (SPEC §4, §10)

import { lineSliceAlong } from '@turf/turf';
import type { LineString } from 'geojson';
import { BikeMap } from './map';
import { RoutingClient, SearchClient, processImport } from './workers';
import { fetchJson, fetchArrayBuffer } from '../core/fetchArtifact';
import { PRIOR_OVERALL_MEAN_KMH } from '../core/classes';
import { DEFAULT_PREFERENCE } from '../core/preference';
import type { Manifest, RouteResult, SpeedProfile } from '../core/types';
import type { SearchHit } from '../workers/protocol';
import { JourneySession, type NavMetrics, type RoutePlan, type SessionState } from '../nav/session';
import { getProfile, saveJourney } from '../history/journeys';
import {
  fmtDistance,
  fmtDuration,
  fmtSpeed,
  fmtPercent,
  etaSourceLabel,
} from './format';
import { renderHistory } from './history-ui';

const DATA_BASE = './data/';

interface Endpoint {
  coord: [number, number];
  label: string;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

class App {
  private map!: BikeMap;
  private routing = new RoutingClient();
  private search = new SearchClient();
  private session!: JourneySession;
  private profile: SpeedProfile | null = null;

  private start: Endpoint | null = null;
  private end: Endpoint | null = null;
  private p = DEFAULT_PREFERENCE;
  private route: RouteResult | null = null;
  private searchSeq = 0;
  private searchDebounce = 0;
  private prefDebounce = 0;

  async boot(): Promise<void> {
    this.setStatus('Loading Málaga data…');
    let manifest: Manifest;
    try {
      manifest = await fetchJson<Manifest>(`${DATA_BASE}manifest.json`);
    } catch {
      this.setStatus('Could not load /data/manifest.json. Run `npm run build:sample-data`.', 'error');
      return;
    }

    this.map = new BikeMap('map', manifest, DATA_BASE);
    this.session = new JourneySession({
      onState: (s) => this.onSessionState(s),
      onUpdate: (m) => this.onSessionUpdate(m),
      onOffRoute: () => this.showOffRoute(true),
      onError: (msg) => this.setStatus(msg, 'error'),
    });

    this.routing.onError = (m) => this.setStatus(m, 'error');
    this.search.onError = (m) => this.setStatus(m, 'error');

    verifyArtifacts(manifest).catch(() => undefined);

    // Load graph + search index in parallel; map renders independently (M1).
    const [graphInfo] = await Promise.all([
      this.routing.load(`${DATA_BASE}graph.bin`),
      this.search
        .load(`${DATA_BASE}search/index.json`, `${DATA_BASE}search/coords.bin`, `${DATA_BASE}search/meta.json`)
        .catch(() => 0),
    ]);

    this.profile = await getProfile();
    this.wireUi();
    this.setStatus(
      `Ready · ${graphInfo.components} network component${graphInfo.components === 1 ? '' : 's'}`,
      'ok',
    );
  }

  // ---- status --------------------------------------------------------------

  private setStatus(msg: string, kind: '' | 'error' | 'ok' = ''): void {
    const el = $('status');
    el.textContent = msg;
    el.className = `status ${kind}`;
  }

  // ---- UI wiring -----------------------------------------------------------

  private wireUi(): void {
    const searchInput = $<HTMLInputElement>('search');
    searchInput.addEventListener('input', () => {
      window.clearTimeout(this.searchDebounce);
      this.searchDebounce = window.setTimeout(() => this.runSearch(searchInput.value), 120);
    });

    $('pref').addEventListener('input', (e) => {
      this.p = parseFloat((e.target as HTMLInputElement).value);
      window.clearTimeout(this.prefDebounce);
      this.prefDebounce = window.setTimeout(() => this.recomputeRoute(), 120);
    });

    $('start-loc').addEventListener('click', () => this.useMyLocation());
    $('swap').addEventListener('click', () => this.swapEndpoints());
    this.map.onClick((c) => this.onMapClick(c));

    $<HTMLInputElement>('import-file').addEventListener('change', (e) => this.onImportFile(e));
    $('import-clear').addEventListener('click', () => this.clearImport());

    $('start-ride').addEventListener('click', () => this.startRide(false));
    $('free-ride').addEventListener('click', () => this.startRide(true));

    $('h-pause').addEventListener('click', () => this.togglePause());
    $('h-stop').addEventListener('click', () => this.stopRide());
    $('h-cancel').addEventListener('click', () => this.session.cancel());
    $('h-recenter').addEventListener('click', () => this.recenterOnPosition());
    $('reroute').addEventListener('click', () => this.reroute());

    $('toggle-history').addEventListener('click', () => this.openHistory());
    $('history-close').addEventListener('click', () => ($('history').hidden = true));
  }

  // ---- search --------------------------------------------------------------

  private async runSearch(text: string): Promise<void> {
    const box = $<HTMLUListElement>('search-results');
    if (!text.trim()) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const seq = ++this.searchSeq;
    const hits = await this.search.query(text, 8);
    if (seq !== this.searchSeq) return; // stale
    this.renderSearchResults(hits);
  }

  private renderSearchResults(hits: SearchHit[]): void {
    const box = $<HTMLUListElement>('search-results');
    box.innerHTML = '';
    if (hits.length === 0) {
      box.hidden = true;
      return;
    }
    for (const hit of hits) {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.innerHTML = `${escapeHtml(hit.display)}<small>${escapeHtml(hit.postcode || '')}</small>`;
      main.addEventListener('click', () => {
        if (hit.coord) {
          this.map.setMarker('search', hit.coord, '#1462d6');
          this.map.flyTo(hit.coord);
        }
      });
      const actions = document.createElement('div');
      actions.className = 'jr-actions';
      const bStart = mkBtn('▶ start', () => this.setEndpoint('start', hit));
      const bEnd = mkBtn('■ end', () => this.setEndpoint('end', hit));
      actions.append(bStart, bEnd);
      li.append(main, actions);
      box.append(li);
    }
    box.hidden = false;
  }

  private setEndpoint(which: 'start' | 'end', hit: SearchHit): void {
    if (!hit.coord) return;
    const ep: Endpoint = { coord: hit.coord, label: hit.display };
    if (which === 'start') this.start = ep;
    else this.end = ep;
    $<HTMLInputElement>(`${which}-label`).value = hit.display;
    this.map.setMarker(which, ep.coord, which === 'start' ? '#1b8a5a' : '#c0392b');
    this.map.setMarker('search', null, '');
    $<HTMLUListElement>('search-results').hidden = true;
    this.recomputeRoute();
  }

  private setEndpointCoord(which: 'start' | 'end', coord: [number, number], label: string): void {
    const ep: Endpoint = { coord, label };
    if (which === 'start') this.start = ep;
    else this.end = ep;
    $<HTMLInputElement>(`${which}-label`).value = label;
    this.map.setMarker(which, coord, which === 'start' ? '#1b8a5a' : '#c0392b');
    this.recomputeRoute();
  }

  private onMapClick(coord: [number, number]): void {
    if (this.session.state === 'ACTIVE' || this.session.state === 'PAUSED') return;
    const which = !this.start ? 'start' : 'end';
    this.setEndpointCoord(which, coord, `${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}`);
  }

  private useMyLocation(): void {
    if (!('geolocation' in navigator)) {
      this.setStatus('Geolocation not available.', 'error');
      return;
    }
    this.setStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        this.setEndpointCoord('start', c, 'My location');
        this.map.flyTo(c);
        this.setStatus('');
      },
      () => this.setStatus('Could not get your location.', 'error'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  private swapEndpoints(): void {
    [this.start, this.end] = [this.end, this.start];
    $<HTMLInputElement>('start-label').value = this.start?.label ?? '';
    $<HTMLInputElement>('end-label').value = this.end?.label ?? '';
    this.map.setMarker('start', this.start?.coord ?? null, '#1b8a5a');
    this.map.setMarker('end', this.end?.coord ?? null, '#c0392b');
    this.recomputeRoute();
  }

  // ---- routing -------------------------------------------------------------

  private async recomputeRoute(): Promise<void> {
    if (!this.start || !this.end) return;
    try {
      this.setStatus('Routing…');
      const result = await this.routing.route({
        start: this.start.coord,
        end: this.end.coord,
        p: this.p,
        profile: this.profile,
      });
      this.route = result;
      this.map.setRoute(result.geometry);
      this.renderRoutePanel(result);
      this.session.setRoute(this.toPlan(result));
      this.setStatus('');
    } catch (err) {
      this.route = null;
      this.map.setRoute(null);
      $('route-panel').hidden = true;
      this.setStatus(err instanceof Error ? err.message : 'Routing failed', 'error');
    }
  }

  private toPlan(result: RouteResult): RoutePlan {
    return {
      geometry: result.geometry,
      distance_m: result.distance_m,
      plannedEta_s: result.eta_s,
      steps: result.steps,
      preferenceP: this.p,
      startLabel: this.start?.label ?? 'Start',
      endLabel: this.end?.label ?? 'Destination',
      startCoord: this.start?.coord ?? null,
      endCoord: this.end?.coord ?? null,
    };
  }

  private renderRoutePanel(r: RouteResult): void {
    $('route-panel').hidden = false;
    $('r-distance').textContent = fmtDistance(r.distance_m);
    $('r-eta').textContent = fmtDuration(r.eta_s);
    $('r-eta-src').textContent = etaSourceLabel(r.etaSource);
    $('r-road').textContent = fmtPercent(r.usedRoadShare);
    const steps = $('r-steps');
    steps.innerHTML = '';
    for (const s of r.steps) {
      const li = document.createElement('li');
      li.textContent = s.text;
      steps.append(li);
    }
  }

  // ---- import (SPEC §11) ---------------------------------------------------

  private async onImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    try {
      this.setStatus('Processing imported GeoJSON…');
      const text = await file.text();
      const geojson = JSON.parse(text);
      const merge = $<HTMLInputElement>('import-merge').checked;
      const out = await processImport(geojson, 12, 'path');
      if (out.type === 'error') {
        this.setStatus(out.error, 'error');
        return;
      }
      const res = await this.routing.loadImport(out.nodes, out.edges, merge, 12);
      $('import-clear').hidden = false;
      const warn = out.warning || res.warning;
      this.setStatus(
        `Imported ${out.featureCount} line(s)${warn ? ` — ${warn}` : ''}`,
        warn ? 'error' : 'ok',
      );
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : 'Import failed', 'error');
    }
  }

  private async clearImport(): Promise<void> {
    await this.routing.clearImport();
    $('import-clear').hidden = true;
    this.setStatus('Reverted to Málaga network.', 'ok');
    if (this.start && this.end) this.recomputeRoute();
  }

  // ---- ride lifecycle ------------------------------------------------------

  private profileSpeed(): number {
    const s = this.profile?.overall.avgSpeed_kmh ?? 0;
    return s > 0 ? s : PRIOR_OVERALL_MEAN_KMH;
  }

  private startRide(free: boolean): void {
    if (!free && !this.route) {
      this.setStatus('Plan a route first, or use free-track.', 'error');
      return;
    }
    void this.session.start({ free, profileSpeed_kmh: this.profileSpeed() });
  }

  private togglePause(): void {
    if (this.session.state === 'ACTIVE') {
      this.session.pause();
      $('h-pause').textContent = 'Resume';
    } else if (this.session.state === 'PAUSED') {
      this.session.resume();
      $('h-pause').textContent = 'Pause';
    }
  }

  private async stopRide(): Promise<void> {
    const journey = this.session.stop();
    if (!journey) return;
    try {
      await saveJourney(journey);
      this.profile = await getProfile();
      this.setStatus(
        `Journey saved · ${fmtDistance(journey.actualDistance_m)} · avg ${fmtSpeed(journey.avgMovingSpeed_kmh)} km/h`,
        'ok',
      );
      this.openHistory();
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  }

  private async reroute(): Promise<void> {
    if (!this.session.state || !this.end) return;
    const pos = this.lastPosition;
    if (!pos) return;
    try {
      const result = await this.routing.route({
        start: pos,
        end: this.end.coord,
        p: this.p,
        profile: this.profile,
      });
      this.route = result;
      this.map.setRoute(result.geometry);
      this.session.setRoute(this.toPlan(result));
      this.showOffRoute(false);
      this.setStatus('Rerouted.', 'ok');
    } catch {
      this.setStatus('Could not reroute.', 'error');
    }
  }

  private recenterOnPosition(): void {
    if (this.lastPosition) this.map.recenter(this.lastPosition);
  }

  // ---- session callbacks ---------------------------------------------------

  private lastPosition: [number, number] | null = null;

  private onSessionState(s: SessionState): void {
    const active = s === 'ACTIVE' || s === 'PAUSED' || s === 'FINISHING';
    $('hud').hidden = !active;
    $('panel').style.display = active ? 'none' : '';
    if (!active) {
      this.map.setProgress(null);
      this.map.setMarker('position', null, '');
      this.showOffRoute(false);
      $('h-pause').textContent = 'Pause';
    }
  }

  private onSessionUpdate(m: NavMetrics): void {
    $('h-speed').textContent = fmtSpeed(m.currentSpeed_kmh);
    $('h-avg').textContent = fmtSpeed(m.avgMovingSpeed_kmh);
    $('h-eta').textContent = m.mode === 'routed' ? fmtDuration(m.dynamicEta_s) : '—';
    $('h-remain').textContent = m.mode === 'routed' ? fmtDistance(m.remainingDistance_m) : '—';
    $('h-covered').textContent = fmtDistance(m.distanceCovered_m);
    $('h-elapsed').textContent = fmtDuration(m.elapsedTime_s);
    $('h-wake').className = `wake ${this.session.hasWakeLock() ? 'on' : ''}`;

    if (m.position) {
      this.lastPosition = m.position;
      this.map.setMarker('position', m.position, '#1462d6');
      this.map.recenter(m.position);
    }
    if (m.mode === 'routed' && this.route && m.plannedDistance_m) {
      const covered = Math.max(0, m.plannedDistance_m - m.remainingDistance_m);
      this.updateProgressOverlay(this.route.geometry, covered);
    }
    if (!m.offRoute) this.showOffRoute(false);
  }

  private updateProgressOverlay(geometry: LineString, covered_m: number): void {
    if (covered_m <= 0) {
      this.map.setProgress(null);
      return;
    }
    try {
      const sliced = lineSliceAlong(geometry, 0, covered_m / 1000, { units: 'kilometers' });
      this.map.setProgress(sliced.geometry as LineString);
    } catch {
      /* ignore slicing edge cases */
    }
  }

  private showOffRoute(on: boolean): void {
    $('hud-offroute').hidden = !on;
  }

  // ---- history -------------------------------------------------------------

  private async openHistory(): Promise<void> {
    $('history').hidden = false;
    await renderHistory({
      onView: (j) => {
        $('history').hidden = true;
        const geom = j.routeGeometry ?? lineFromTrack(j.track);
        if (geom) this.map.setRoute(geom);
      },
      onChanged: async () => {
        this.profile = await getProfile();
      },
    });
  }
}

function lineFromTrack(track: [number, number][]): LineString | null {
  if (track.length < 2) return null;
  return { type: 'LineString', coordinates: track };
}

function mkBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'ghost';
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

// Runtime checksum verification of small artifacts (SPEC §6 Stage 6).
async function verifyArtifacts(manifest: Manifest): Promise<void> {
  if (!crypto?.subtle) return;
  for (const [name, entry] of Object.entries(manifest.artifacts)) {
    if (entry.bytes > 16 * 1024 * 1024) continue; // skip large basemap
    try {
      const buf = await fetchArrayBuffer(`${DATA_BASE}${entry.path}`);
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (entry.sha256 && hex !== entry.sha256) {
        console.warn(`Checksum mismatch for ${name}: expected ${entry.sha256}, got ${hex}`);
      }
    } catch {
      /* artifact missing — handled elsewhere */
    }
  }
}

new App().boot().catch((err) => {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = err instanceof Error ? err.message : String(err);
    el.className = 'status error';
  }
});
