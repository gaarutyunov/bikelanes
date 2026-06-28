// Stage 5 — build display tiles (SPEC §6 Stage 5). Requires Planetiler/tippecanoe
// installed locally; build-time only. If the tools are absent the sample build
// falls back to the bikelanes.geojson display layer instead of PMTiles.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DATA_DIR, RAW_DIR } from './util';

function has(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return r.status === 0 || r.status === null ? r.error === undefined : false;
}

/** Returns true if PMTiles were produced; false if tools are missing. */
export function buildTiles(): boolean {
  if (!has('tippecanoe')) {
    console.warn('  ⚠ tippecanoe not found — skipping PMTiles, using GeoJSON display layer.');
    return false;
  }
  const src = join(RAW_DIR, 'carriles-bici.geojson');
  const out = join(DATA_DIR, 'bikelanes.pmtiles');
  const r = spawnSync(
    'tippecanoe',
    ['-zg', '-o', out, '--force', '-l', 'bikelanes', '--drop-densest-as-needed', src],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.warn('  ⚠ tippecanoe failed — falling back to GeoJSON display layer.');
    return false;
  }
  console.log('  ✓ bikelanes.pmtiles');
  console.log('  ℹ Basemap: run Planetiler/Protomaps separately to produce basemap.pmtiles.');
  return true;
}
