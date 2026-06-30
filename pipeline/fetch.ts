// Stage 1 — acquire raw source data into pipeline/raw (SPEC §5, §6 Stage 1).
// Build-time only; requires network access (available on CI runners).
//
// Primary source is OpenStreetMap via Overpass — one reliable, programmatic API
// with Málaga's cycleways, roads AND addresses. The municipal carril-bici layer
// is fetched as a best-effort *authoritative augmentation*: if the portal URL is
// unavailable the build proceeds with OSM cycleways alone (it is not a runtime
// fallback — see §3).

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, RAW_DIR } from './util';
import { fetchOsmRoads, fetchOsmAddresses, ckanGeojson4326Url, type Bbox } from './network';

// Best-effort authoritative bike layer. We resolve the current download URL from
// the CKAN dataset (stable slug), falling back to the known portal path.
export const CARRILES_BICI_DATASET = 'carriles-bici';
export const CARRILES_BICI_URL_FALLBACK =
  'https://datosabiertos.malaga.eu/recursos/transporte/trafico/da_carrilBici-4326.geojson';

export const MALAGA_BBOX: Bbox = { south: 36.66, west: -4.55, north: 36.78, east: -4.34 };

const FORCE = process.env.FORCE_FETCH === '1';
const have = (dest: string) => !FORCE && existsSync(join(RAW_DIR, dest));

function save(dest: string, data: string | Buffer): void {
  writeFileSync(join(RAW_DIR, dest), data);
}

export async function fetchAll(): Promise<void> {
  ensureDir(RAW_DIR);
  console.log('Stage 1 — fetching raw sources…');

  // Required: OSM highways (roads + cycleways) via Overpass.
  if (have('osm-roads.json')) {
    console.log('  • osm-roads.json (cached)');
  } else {
    console.log('  ↓ OSM highways via Overpass…');
    save('osm-roads.json', JSON.stringify(await fetchOsmRoads(MALAGA_BBOX)));
  }

  // Required: OSM addresses via Overpass.
  if (have('osm-addresses.json')) {
    console.log('  • osm-addresses.json (cached)');
  } else {
    console.log('  ↓ OSM addresses via Overpass…');
    save('osm-addresses.json', JSON.stringify(await fetchOsmAddresses(MALAGA_BBOX)));
  }

  // Best-effort: authoritative municipal carril-bici (non-fatal on failure).
  if (have('carriles-bici.geojson')) {
    console.log('  • carriles-bici.geojson (cached)');
  } else {
    try {
      let url = CARRILES_BICI_URL_FALLBACK;
      try {
        const resolved = await ckanGeojson4326Url(CARRILES_BICI_DATASET);
        if (resolved) url = resolved;
      } catch {
        /* CKAN lookup failed — use the fallback path */
      }
      const res = await fetch(url, { headers: { 'User-Agent': 'BikeNavMalaga/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      save('carriles-bici.geojson', Buffer.from(await res.arrayBuffer()));
      console.log(`  ↓ carriles-bici.geojson (municipal)`);
    } catch (err) {
      console.warn(
        `  ⚠ municipal carril-bici unavailable (${err instanceof Error ? err.message : err}); using OSM cycleways only.`,
      );
    }
  }

  console.log('Stage 1 complete.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
