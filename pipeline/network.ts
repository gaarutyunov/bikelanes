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
  if (tags.bicycle === 'no' || tags.access === 'no') return null;
  const map: Record<string, string> = {
    cycleway: 'cycleway',
    path: 'path',
    footway: 'path',
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
