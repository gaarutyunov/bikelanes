// Build-time only: Overpass road download + OSM→GeoJSON conversion (SPEC §5, §6
// Stage 1). Runs locally by a maintainer; never invoked at runtime.

import type { Feature, FeatureCollection, LineString } from 'geojson';

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Query OSM ways (highways + cycleways) for cycling-permission tags. */
export function overpassQuery(b: Bbox): string {
  return `[out:json][timeout:180];
(
  way["highway"](${b.south},${b.west},${b.north},${b.east});
);
out body geom;`;
}

export async function fetchOsmRoads(b: Bbox): Promise<unknown> {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(overpassQuery(b))}`,
  });
  if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
  return res.json();
}

interface OsmWay {
  type: string;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

// Map an OSM highway tag to an internal edge class (SPEC §7.2). Excluded
// highways are tagged so buildGraph drops them.
function clsFromTags(tags: Record<string, string>): string | null {
  const hw = tags.highway;
  if (!hw) return null;
  if (hw === 'motorway' || hw === 'motorway_link') return null;
  if (tags.bicycle === 'no' || tags.access === 'no' || tags.access === 'private') return null;
  if (hw === 'cycleway') return 'cycleway';
  // Bike-priority streets and on-road cycle lanes tagged on a road way.
  if (tags.bicycle_road === 'yes' || tags.cyclestreet === 'yes') return 'cycle_street';
  const cw =
    tags.cycleway ?? tags['cycleway:both'] ?? tags['cycleway:left'] ?? tags['cycleway:right'] ?? '';
  if (/(lane|track|share_busway|opposite_lane|opposite_track)/.test(cw)) return 'cycle_lane';
  const map: Record<string, string> = {
    path: 'path',
    footway: 'path',
    pedestrian: 'path',
    living_street: 'living_street',
    residential: 'residential',
    tertiary: 'tertiary',
    tertiary_link: 'link',
    secondary: 'secondary',
    secondary_link: 'link',
    primary: 'primary',
    primary_link: 'link',
    trunk: 'primary',
    trunk_link: 'link',
    unclassified: 'residential',
    service: 'residential',
  };
  return map[hw] ?? null;
}

// ---- OSM addresses (replaces the fragile municipal SIC Número/Vial join) ----

export function overpassAddressQuery(b: Bbox): string {
  return `[out:json][timeout:180];
(
  node["addr:housenumber"]["addr:street"](${b.south},${b.west},${b.north},${b.east});
  way["addr:housenumber"]["addr:street"](${b.south},${b.west},${b.north},${b.east});
);
out center;`;
}

export async function fetchOsmAddresses(b: Bbox): Promise<unknown> {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(overpassAddressQuery(b))}`,
  });
  if (!res.ok) throw new Error(`Overpass (addresses) returned ${res.status}`);
  return res.json();
}

export interface OsmAddress {
  display: string;
  street: string;
  number: string;
  postcode: string;
  lon: number;
  lat: number;
}

interface OsmAddrEl {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function osmAddressesToRecords(osm: unknown): OsmAddress[] {
  const elements = (osm as { elements?: OsmAddrEl[] }).elements ?? [];
  const out: OsmAddress[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const tags = el.tags ?? {};
    const street = tags['addr:street'];
    const number = tags['addr:housenumber'];
    if (!street || !number) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const display = `${street} ${number}`;
    const key = `${display}@${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      display,
      street,
      number,
      postcode: tags['addr:postcode'] ?? '',
      lon: round6(lon),
      lat: round6(lat),
    });
  }
  return out;
}

export function osmToGeoJson(osm: unknown): FeatureCollection {
  const elements = (osm as { elements?: OsmWay[] }).elements ?? [];
  const features: Feature[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const cls = clsFromTags(tags);
    if (!cls) continue;
    const geometry: LineString = {
      type: 'LineString',
      coordinates: el.geometry.map((g) => [round6(g.lon), round6(g.lat)]),
    };
    features.push({
      type: 'Feature',
      properties: { cls, oneway: tags.oneway ?? 'no', highway: tags.highway },
      geometry,
    });
  }
  return { type: 'FeatureCollection', features };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
