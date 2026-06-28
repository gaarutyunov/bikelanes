// Generate a small synthetic central-Málaga dataset so the app loads & routes
// without the full GDAL/Overpass/tippecanoe toolchain. Real data is produced by
// `npm run build:data` (pipeline/index.ts); this is the committed default.

import type { Feature, FeatureCollection, LineString } from 'geojson';
import { buildAndWriteGraph } from './graph';
import { buildAndWriteSearch, type AddressInput } from './search';
import { writeManifest } from './manifest';
import { DATA_DIR, ensureDir } from './util';

const BASE_LON = -4.44;
const BASE_LAT = 36.7;
const STEP = 0.003;
const COLS = 7;
const ROWS = 6;

// Street name per row; a couple carry accents/ñ to exercise the search folding.
const ROW_NAMES = [
  'Calle Larios',
  'Avenida de Andalucía',
  'Paseo del Parque',
  'Calle Compañía',
  'Avenida de la Rosaleda',
  'Calle Victoria',
];

// Rows that are cycle infrastructure (two parallel lanes for the M3 scenario).
const ROW_CLASS: Record<number, string> = {
  2: 'cycleway', // segregated track
  4: 'cycle_lane', // on-road painted lane
};

function lon(c: number): number {
  return +(BASE_LON + c * STEP).toFixed(6);
}
function lat(r: number): number {
  return +(BASE_LAT + r * STEP).toFixed(6);
}

function line(coords: [number, number][], props: Record<string, unknown>): Feature {
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'LineString', coordinates: coords } as LineString,
  };
}

function buildNetwork(): FeatureCollection {
  const features: Feature[] = [];
  // Horizontal streets (one per row).
  for (let r = 0; r < ROWS; r++) {
    const coords: [number, number][] = [];
    for (let c = 0; c < COLS; c++) coords.push([lon(c), lat(r)]);
    features.push(line(coords, { cls: ROW_CLASS[r] ?? 'residential' }));
  }
  // Vertical streets (one per column) — these connect the two cycle lanes.
  for (let c = 0; c < COLS; c++) {
    const coords: [number, number][] = [];
    for (let r = 0; r < ROWS; r++) coords.push([lon(c), lat(r)]);
    features.push(line(coords, { cls: 'residential' }));
  }
  // A diagonal segregated cycleway for visual variety.
  features.push(
    line(
      [
        [lon(0), lat(0)],
        [lon(3), lat(3)],
        [lon(6), lat(5)],
      ],
      { cls: 'cycleway' },
    ),
  );
  return { type: 'FeatureCollection', features };
}

function buildAddresses(): AddressInput[] {
  const out: AddressInput[] = [];
  let id = 0;
  for (let r = 0; r < ROWS; r++) {
    const street = ROW_NAMES[r] ?? `Calle ${r}`;
    for (let c = 0; c < COLS; c++) {
      const number = String(c * 4 + 2);
      out.push({
        id: id++,
        display: `${street} ${number}`,
        street,
        number,
        postcode: `2900${(r % 9) + 1}`,
        lon: lon(c),
        lat: lat(r),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  ensureDir(DATA_DIR);
  console.log('Building sample dataset…');
  const graph = buildAndWriteGraph(buildNetwork(), { tolerance_m: 12 });
  console.log(
    `  graph.bin: ${graph.nodes} nodes, ${graph.edges} edges, ${graph.components} component(s)`,
  );
  for (const w of graph.warnings) console.log(`  ⚠ ${w}`);

  const search = await buildAndWriteSearch(buildAddresses());
  console.log(`  search index: ${search.records} addresses`);

  writeManifest({
    bbox: graph.bbox,
    basemap: { kind: 'none' },
    bikelanes: { kind: 'geojson', path: 'bikelanes.geojson' },
    searchRecords: search.records,
    buildDate: process.env.BUILD_DATE ?? '1970-01-01T00:00:00.000Z',
  });
  console.log('  manifest.json written.');
  console.log('Sample dataset complete → /data');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
