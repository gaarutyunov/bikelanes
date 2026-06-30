// Build-time only: Overpass road download + OSM→GeoJSON conversion (SPEC §5, §6
// Stage 1). Runs locally by a maintainer; never invoked at runtime.

import type { Feature, FeatureCollection, LineString } from 'geojson';

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

// Mirrors tried in order. overpass-api.de now returns HTTP 406 for requests
// without a descriptive User-Agent, so we always send one (and a sane Accept).
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_UA = 'BikeNavMalaga/1.0 (+https://github.com/gaarutyunov/bikelanes)';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POST an Overpass QL query, trying mirrors and retrying transient failures. */
export async function overpassFetch(query: string): Promise<unknown> {
  let lastErr: unknown = new Error('Overpass: no endpoints tried');
  for (const url of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': OVERPASS_UA,
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (res.status === 429 || res.status === 504 || res.status === 503) {
          lastErr = new Error(`Overpass ${res.status} (busy)`);
          await sleep(2000 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new Error(`Overpass returned ${res.status} from ${url}`);
        return await res.json();
      } catch (err) {
        lastErr = err;
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Query OSM ways (highways + cycleways) for cycling-permission tags. */
export function overpassQuery(b: Bbox): string {
  return `[out:json][timeout:180];
(
  way["highway"](${b.south},${b.west},${b.north},${b.east});
);
out body geom;`;
}

export async function fetchOsmRoads(b: Bbox): Promise<unknown> {
  return overpassFetch(overpassQuery(b));
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

// ---- Municipal portal (CKAN) resolution ------------------------------------

const MALAGA_PORTAL = 'https://datosabiertos.malaga.eu';

interface CkanResource {
  format?: string;
  name?: string;
  url?: string;
}

/**
 * Resolve a dataset's GeoJSON (EPSG:4326) download URL via the CKAN API by
 * stable dataset slug — robust to the resource path/filename changing. Returns
 * null if the API or a matching resource isn't available (best-effort).
 */
export async function ckanGeojson4326Url(slug: string): Promise<string | null> {
  const res = await fetch(`${MALAGA_PORTAL}/api/3/action/package_show?id=${slug}`, {
    headers: { 'User-Agent': OVERPASS_UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CKAN package_show ${slug} → ${res.status}`);
  const json = (await res.json()) as { result?: { resources?: CkanResource[] } };
  const resources = json.result?.resources ?? [];
  const isGeo = (r: CkanResource) => /geojson/i.test(r.format ?? '') || /\.geojson\b/i.test(r.url ?? '');
  const is4326 = (r: CkanResource) => /4326/.test(`${r.name ?? ''} ${r.url ?? ''}`);
  const pick = resources.find((r) => isGeo(r) && is4326(r)) ?? resources.find(isGeo);
  return pick?.url ?? null;
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
  return overpassFetch(overpassAddressQuery(b));
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
