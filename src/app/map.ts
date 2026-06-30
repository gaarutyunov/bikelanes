// MapLibre map: basemap (PMTiles when available), bike-lanes display layer,
// route + progress overlays, and markers (SPEC §10).

import maplibregl, { type StyleSpecification, type LngLatLike } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { Feature, LineString } from 'geojson';
import type { Manifest } from '../core/types';

let protocolRegistered = false;

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

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
        paint: { 'line-color': '#1b8a5a', 'line-width': 2.5 },
      });
    } else {
      sources.bikelanes = { type: 'geojson', data: `${dataBase}${manifest.bikelanes.path}` };
      layers.push({
        id: 'bikelanes',
        type: 'line',
        source: 'bikelanes',
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'bike',
            '#1b8a5a',
            'connector',
            '#c98a00',
            '#9aa3ad',
          ],
          'line-width': ['match', ['get', 'kind'], 'bike', 3, 1.5],
        },
      });
    }
    return { version: 8, sources, layers } as StyleSpecification;
  }

  private addOverlays(): void {
    this.map.addSource('route', { type: 'geojson', data: EMPTY_FC });
    this.map.addSource('progress', { type: 'geojson', data: EMPTY_FC });
    this.map.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1462d6', 'line-width': 5, 'line-opacity': 0.85 },
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

  setRoute(geometry: LineString | null): void {
    const src = this.map.getSource('route') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(geometry ? ({ type: 'Feature', properties: {}, geometry } as Feature) : EMPTY_FC);
    if (geometry && geometry.coordinates.length > 1) {
      const b = new maplibregl.LngLatBounds();
      for (const c of geometry.coordinates) b.extend(c as [number, number]);
      this.map.fitBounds(b, { padding: 60, maxZoom: 16 });
    }
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
