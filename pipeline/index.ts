// Offline build orchestrator — `npm run build:data` (SPEC §6).
// Reads pipeline/raw (populated by `npm run fetch:data`) and writes /data.
// Run automatically by CI on every deploy/preview; never by hand.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, FeatureCollection } from 'geojson';
import { buildAndWriteGraph } from './graph';
import { buildAndWriteSearch, type AddressInput } from './search';
import { buildTiles } from './tiles';
import { writeManifest } from './manifest';
import { osmToGeoJson, osmAddressesToRecords } from './network';
import { RAW_DIR, rawExists, readRawJson } from './util';

// Authoritative municipal bike lanes, if present (best-effort fetch).
function loadBikeLanes(): Feature[] {
  if (!rawExists('carriles-bici.geojson')) return [];
  const fc = readRawJson<FeatureCollection>('carriles-bici.geojson');
  return (fc.features ?? [])
    .filter((f) => f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString')
    .flatMap((f) => splitMulti(f))
    .map((f) => ({
      ...f,
      properties: { ...(f.properties ?? {}), cls: 'cycleway' },
    }));
}

// Normalize MultiLineString features into LineStrings (buildGraph wants lines).
function splitMulti(f: Feature): Feature[] {
  if (f.geometry?.type === 'MultiLineString') {
    return f.geometry.coordinates.map((coords) => ({
      type: 'Feature',
      properties: f.properties,
      geometry: { type: 'LineString', coordinates: coords },
    }));
  }
  return [f];
}

// OSM highways → roads + cycleways (cycling-permission tags applied).
function loadRoads(): Feature[] {
  if (!rawExists('osm-roads.json')) return [];
  const osm = JSON.parse(readFileSync(join(RAW_DIR, 'osm-roads.json'), 'utf8'));
  return osmToGeoJson(osm).features;
}

// OSM address points → search records.
function buildAddresses(): AddressInput[] {
  if (!rawExists('osm-addresses.json')) return [];
  const osm = JSON.parse(readFileSync(join(RAW_DIR, 'osm-addresses.json'), 'utf8'));
  return osmAddressesToRecords(osm).map((a, i) => ({
    id: i,
    display: a.display,
    street: a.street,
    number: a.number,
    postcode: a.postcode,
    lon: a.lon,
    lat: a.lat,
  }));
}

async function main(): Promise<void> {
  if (!rawExists('osm-roads.json')) {
    console.error('No raw data found. Run `npm run fetch:data` first (needs network access).');
    process.exit(1);
  }

  console.log('Stage 2/3 — building routing graph…');
  const bike = loadBikeLanes();
  const roads = loadRoads();
  console.log(`  ${bike.length} municipal bike features + ${roads.length} OSM highway features`);
  const features = [...bike, ...roads];
  if (features.length === 0) throw new Error('No input features — cannot build a graph.');
  const graph = buildAndWriteGraph({ type: 'FeatureCollection', features }, { tolerance_m: 12 });
  console.log(`  ${graph.nodes} nodes, ${graph.edges} edges, ${graph.components} component(s)`);
  for (const w of graph.warnings) console.log(`  ⚠ ${w}`);

  console.log('Stage 4 — building address index…');
  const search = await buildAndWriteSearch(buildAddresses());
  console.log(`  ${search.records} addresses`);

  console.log('Stage 5 — building display tiles…');
  const pmtiles = buildTiles();

  console.log('Stage 6 — writing manifest…');
  writeManifest({
    bbox: graph.bbox,
    basemap: { kind: 'none' },
    bikelanes: pmtiles
      ? { kind: 'pmtiles', path: 'bikelanes.pmtiles' }
      : { kind: 'geojson', path: 'bikelanes.geojson' },
    searchRecords: search.records,
    buildDate: new Date().toISOString(),
  });
  console.log('Build complete → /data');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
