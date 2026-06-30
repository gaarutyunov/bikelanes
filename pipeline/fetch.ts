// Stage 1 — acquire raw municipal + OSM source data into pipeline/raw
// (SPEC §5, §6 Stage 1). Build-time only; requires network access.

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, RAW_DIR } from './util';
import { fetchOsmRoads, type Bbox } from './network';

// Skip files already present (cached raw) unless FORCE_FETCH=1.
const FORCE = process.env.FORCE_FETCH === '1';
const have = (dest: string) => !FORCE && existsSync(join(RAW_DIR, dest));

// Málaga municipal open-data endpoints (carriles-bici, SIC Número/Vial).
// Confirm/update URLs against the portal before a production data build.
export const SOURCES = {
  carrilesBici:
    'https://datosabiertos.malaga.eu/recursos/transporte/trafico/carrilbici/da_carrilBici-4326.geojson',
  numero:
    'https://datosabiertos.malaga.eu/recursos/urbanismoEInfraestructura/cartografiaBasica/da_cartografiaNumero-4326.geojson',
  vial: 'https://datosabiertos.malaga.eu/recursos/urbanismoEInfraestructura/cartografiaBasica/da_vial.csv',
};

export const MALAGA_BBOX: Bbox = { south: 36.66, west: -4.55, north: 36.78, east: -4.34 };

async function download(url: string, dest: string): Promise<void> {
  if (have(dest)) {
    console.log(`  • ${dest} (cached)`);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(RAW_DIR, dest), buf);
  console.log(`  ↓ ${dest} (${(buf.length / 1024).toFixed(0)} KB)`);
}

export async function fetchAll(): Promise<void> {
  ensureDir(RAW_DIR);
  console.log('Stage 1 — fetching raw sources…');
  await download(SOURCES.carrilesBici, 'carriles-bici.geojson');
  await download(SOURCES.numero, 'numero.geojson');
  await download(SOURCES.vial, 'vial.csv');
  if (have('osm-roads.json')) {
    console.log('  • osm-roads.json (cached)');
  } else {
    console.log('  ↓ OSM roads via Overpass…');
    const osm = await fetchOsmRoads(MALAGA_BBOX);
    writeFileSync(join(RAW_DIR, 'osm-roads.json'), JSON.stringify(osm));
  }
  console.log('Stage 1 complete.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
