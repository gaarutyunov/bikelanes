// MapLibre map: basemap (PMTiles when available), bike-lanes display layer,
// route + progress overlays, and markers (SPEC §10).

import maplibregl, { type StyleSpecification, type LngLatLike } from 'maplibre-gl';
// MapLibre ships its DOM chrome unstyled: without this stylesheet
// `.maplibregl-canvas-container`, `.maplibregl-marker` and the control
// containers stay `position: static`, so every Marker (start, destination,
// live position) and every control (zoom, attribution) is laid out *after*
// the full-height canvas in normal flow — i.e. off-screen. The library does
// not inject it, so it must be imported explicitly.
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import type { Manifest } from '../core/types';

let protocolRegistered = false;

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

// Surface palette: bike infrastructure in Málaga's vine-red lane colour, roads
// in blue (SPEC §10 / §21).
const BIKE_COLOR = '#9b1c3d';
const ROAD_COLOR = '#1462d6';
const CONNECTOR_COLOR = '#c98a00';
// Pavements and pedestrian streets. Routable, but not bike infrastructure and
// ten times the length of the real lane network — drawn as faint context so the
// lanes stay legible (SPEC §10).
const FOOT_COLOR = '#9aa5b1';
// Sharrows: a marked bike route sharing a traffic lane. Preferred over a bare
// road but not a lane, so it reads as a washed-out version of the lane colour.
const SHARED_COLOR = '#c98aa0';
// Casing drawn under the route line so it reads as a distinct ribbon on top of
// the (identically coloured) lane/road network.
const CASING_COLOR = '#ffffff';

export class BikeMap {
  map: maplibregl.Map;
  private markers = new Map<string, maplibregl.Marker>();

  constructor(container: string, manifest: Manifest, dataBase: string) {
    if (!protocolRegistered) {
      const protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      protocolRegistered = true;
    }
    const [minLon, minLat, maxLon, maxLat] = manifest.bbox;
    const center: LngLatLike = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];

    this.map = new maplibregl.Map({
      container,
      style: this.buildStyle(manifest, dataBase),
      center,
      zoom: 13,
      attributionControl: false,
    });
    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: manifest.attribution,
      }),
    );
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.on('load', () => this.addOverlays());
  }

  private buildStyle(manifest: Manifest, dataBase: string): StyleSpecification {
    const sources: StyleSpecification['sources'] = {};
    const layers: StyleSpecification['layers'] = [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef1f4' } },
    ];

    if (manifest.basemap.kind === 'pmtiles' && manifest.basemap.path) {
      sources.basemap = {
        type: 'vector',
        url: `pmtiles://${dataBase}${manifest.basemap.path}`,
        attribution: '© OpenStreetMap contributors',
      };
      layers.push(
        {
          id: 'land',
          type: 'fill',
          source: 'basemap',
          'source-layer': 'water',
          paint: { 'fill-color': '#bcd4e6' },
        },
        {
          id: 'roads',
          type: 'line',
          source: 'basemap',
          'source-layer': 'roads',
          paint: { 'line-color': '#d9dde2', 'line-width': 1.2 },
        },
      );
    }

    // Bike-lanes display layer (PMTiles or GeoJSON depending on the build).
    if (manifest.bikelanes.kind === 'pmtiles') {
      sources.bikelanes = {
        type: 'vector',
        url: `pmtiles://${dataBase}${manifest.bikelanes.path}`,
      };
      layers.push({
        id: 'bikelanes',
        type: 'line',
        source: 'bikelanes',
        'source-layer': 'bikelanes',
        paint: { 'line-color': BIKE_COLOR, 'line-width': 2.5 },
      });
    } else {
      sources.bikelanes = { type: 'geojson', data: `${dataBase}${manifest.bikelanes.path}` };
      layers.push({
        id: 'bikelanes',
        type: 'line',
        source: 'bikelanes',
        // Draw lanes last so they sit on top of the pavement/road mesh rather
        // than wherever they happen to fall in the edge list.
        layout: { 'line-sort-key': ['match', ['get', 'kind'], 'foot', 0, 'bike', 3, 1] },
        paint: {
          // Bike lanes in vine red, shared lanes in a washed-out red, roads in
          // blue, pavements faint grey, connectors amber (§10).
          'line-color': [
            'match',
            ['get', 'kind'],
            'bike',
            BIKE_COLOR,
            'shared',
            SHARED_COLOR,
            'connector',
            CONNECTOR_COLOR,
            'foot',
            FOOT_COLOR,
            ROAD_COLOR,
          ],
          'line-width': ['match', ['get', 'kind'], 'bike', 3, 'shared', 2, 'foot', 0.6, 1],
          'line-opacity': ['match', ['get', 'kind'], 'bike', 0.9, 'shared', 0.75, 'foot', 0.3, 0.45],
        },
      });
    }
    return { version: 8, sources, layers } as StyleSpecification;
  }

  private addOverlays(): void {
    this.map.addSource('route', { type: 'geojson', data: EMPTY_FC });
    this.map.addSource('progress', { type: 'geojson', data: EMPTY_FC });
    // Casing under the route. The route is coloured by surface with the *same*
    // two colours as the bike-lane/road display layer it is drawn over, so
    // without a casing it is indistinguishable from the network beneath it.
    this.map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': CASING_COLOR, 'line-width': 11, 'line-opacity': 0.95 },
    });
    this.map.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Colour each route run by surface: bike infra vine-red, roads blue.
        'line-color': ['match', ['get', 'kind'], 'bike', BIKE_COLOR, ROAD_COLOR],
        'line-width': 5,
        'line-opacity': 0.9,
      },
    });
    this.map.addLayer({
      id: 'progress',
      type: 'line',
      source: 'progress',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0a2f66', 'line-width': 6, 'line-opacity': 0.9 },
    });
  }

  onReady(cb: () => void): void {
    if (this.map.isStyleLoaded()) cb();
    else this.map.on('load', cb);
  }

  /**
   * Render the route. When `segments` (bike-vs-road runs) are supplied the line
   * is coloured by surface; otherwise it falls back to a single road-coloured
   * line (e.g. a history track without per-surface data).
   */
  setRoute(geometry: LineString | null, segments?: FeatureCollection | null): void {
    const src = this.map.getSource('route') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!geometry) {
      src.setData(EMPTY_FC);
      return;
    }
    if (segments && segments.features.length > 0) {
      src.setData(segments);
    } else {
      src.setData({ type: 'Feature', properties: { kind: 'road' }, geometry } as Feature);
    }
    if (geometry.coordinates.length > 1) {
      const b = new maplibregl.LngLatBounds();
      for (const c of geometry.coordinates) b.extend(c as [number, number]);
      this.map.fitBounds(b, { padding: this.framePadding(), maxZoom: 16 });
    }
  }

  /**
   * Padding for `fitBounds`, keeping the route and its markers clear of the
   * control panel that floats over the map. Without it a fitted route is
   * centred in the *container*, which puts the start or destination marker
   * underneath the panel and invisible.
   */
  private framePadding(): maplibregl.PaddingOptions {
    const base = 60;
    const panel = document.getElementById('panel');
    const container = this.map.getContainer().getBoundingClientRect();
    if (!panel || panel.hidden || container.width === 0) {
      return { top: base, bottom: base, left: base, right: base };
    }
    const rect = panel.getBoundingClientRect();
    // Never claim more than 40% of the container, or fitBounds has nowhere left
    // to put the route (the panel is full-width on a phone).
    const left = Math.min(rect.right - container.left + 12, container.width * 0.4);
    return { top: base, bottom: base, right: base, left: Math.max(base, left) };
  }

  setProgress(geometry: LineString | null): void {
    const src = this.map.getSource('progress') as maplibregl.GeoJSONSource | undefined;
    src?.setData(geometry ? ({ type: 'Feature', properties: {}, geometry } as Feature) : EMPTY_FC);
  }

  setMarker(key: string, coord: [number, number] | null, color: string): void {
    let m = this.markers.get(key);
    if (!coord) {
      m?.remove();
      this.markers.delete(key);
      return;
    }
    if (!m) {
      m = new maplibregl.Marker({ color });
      this.markers.set(key, m);
    }
    m.setLngLat(coord).addTo(this.map);
  }

  flyTo(coord: [number, number], zoom = 15): void {
    this.map.flyTo({ center: coord, zoom });
  }

  recenter(coord: [number, number]): void {
    this.map.easeTo({ center: coord });
  }

  onClick(cb: (coord: [number, number]) => void): void {
    this.map.on('click', (e) => cb([e.lngLat.lng, e.lngLat.lat]));
  }
}
