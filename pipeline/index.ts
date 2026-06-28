// Offline build orchestrator — `npm run build:data` (SPEC §6).
// Stages: acquire (separate `fetch`) → build graph → build search → tiles →
// manifest. Run locally by a maintainer; the resulting /data/* is committed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, FeatureCollection } from 'geojson';
import { buildAndWriteGraph } from './graph';
import { buildAndWriteSearch, type AddressInput } from './search';
import { buildTiles } from './tiles';
import { writeManifest } from './manifest';
import { osmToGeoJson } from './network';
import { RAW_DIR, rawExists, readRawJson } from './util';

function loadBikeLanes(): Feature[] {
  const fc = readRawJson<FeatureCollection>('carriles-bici.geojson');
  return (fc.features ?? []).map((f) => ({
    ...f,
    properties: { ...(f.properties ?? {}), cls: (f.properties as { cls?: string })?.cls ?? 'cycleway' },
  }));
}

function loadRoads(): Feature[] {
  if (!rawExists('osm-roads.json')) return [];
  const osm = JSON.parse(readFileSync(join(RAW_DIR, 'osm-roads.json'), 'utf8'));
  return osmToGeoJson(osm).features;
}

// --- Address index (Stage 4): join Número → Vial -----------------------------

const TIPO_PREFIX: Record<string, string> = {
  CL: 'Calle',
  AV: 'Avenida',
  PS: 'Paseo',
  PZ: 'Plaza',
  CR: 'Carretera',
  CM: 'Camino',
  GL: 'Glorieta',
  TR: 'Travesía',
};

function parseCsv(text: string): Record<string, string>[] {
  const delim = text.indexOf(';') >= 0 && text.indexOf(';') < text.indexOf('\n') ? ';' : ',';
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(delim).map((h) => h.trim());
  return lines.slice(1).map((ln) => {
    const cells = ln.split(delim);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
}

function buildAddresses(): AddressInput[] {
  if (!rawExists('numero.geojson') || !rawExists('vial.csv')) return [];
  const numero = readRawJson<FeatureCollection>('numero.geojson');
  const vialRows = parseCsv(readFileSync(join(RAW_DIR, 'vial.csv'), 'utf8'));
  const vialByCod = new Map<string, Record<string, string>>();
  for (const row of vialRows) {
    const cod = row.CODVIAL ?? row.codvial;
    if (cod) vialByCod.set(cod, row);
  }

  const out: AddressInput[] = [];
  let id = 0;
  for (const f of numero.features ?? []) {
    const props = (f.properties ?? {}) as Record<string, string>;
    if (props.FECBAJA) continue; // dropped baja rows
    const tip = props.TIPNUMERO;
    if (tip && tip !== 'P' && tip !== 'A') continue;
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const cod = props.CODVIAL;
    const vial = cod ? vialByCod.get(cod) : undefined;
    const nomvial = vial?.NOMVIAL ?? props.NOMVIAL ?? '';
    if (!nomvial) continue;
    const prefix = TIPO_PREFIX[vial?.CODTIPVIAL ?? props.CODTIPVIAL ?? ''] ?? '';
    const street = `${prefix} ${nomvial}`.trim();
    const number = props.NUMERO ?? props.NUM ?? '';
    const [lon, lat] = (f.geometry.coordinates as [number, number]) ?? [0, 0];
    out.push({
      id: id++,
      display: `${street} ${number}`.trim(),
      street,
      number,
      postcode: props.COD_POSTAL ?? props.CP ?? '',
      lon,
      lat,
    });
  }
  return out;
}

async function main(): Promise<void> {
  if (!rawExists('carriles-bici.geojson')) {
    console.error('No raw data found. Run `tsx pipeline/fetch.ts` first, or use `npm run build:sample-data`.');
    process.exit(1);
  }
  console.log('Stage 2/3 — building routing graph…');
  const features = [...loadBikeLanes(), ...loadRoads()];
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
