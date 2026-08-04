// Routing regression gate — `npm run check:routing` (run by CI after
// `build:data`).
//
// Issue #5: the app routed riders down pavements and main roads while the lane
// network sat unused, because `isBike` counted `highway=footway` as bike
// infrastructure and `cycleway*=shared_lane` as a cycle lane. A route that
// looks plausible is not evidence of anything, so this asserts the property the
// app exists for: over a fixed set of Málaga corridors, most of the routed
// distance is on real bike infrastructure and almost none is on pavement.
//
// It drives the production router (`Dataset`) against the real built
// `data/graph.bin`, so it fails if either the cost model or the build-time
// classification regresses.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeGraph } from '../src/core/graphFormat';
import { Dataset } from '../src/workers/dataset';
import { classFromId, isBike, type EdgeClass } from '../src/core/classes';
import { DEFAULT_PREFERENCE } from '../src/core/preference';
import type { RouteResult } from '../src/core/types';

interface Case {
  name: string;
  start: [number, number];
  end: [number, number];
}

// Fixed origin/destination pairs spread across the city, each 2.5–4.5 km, all
// in the graph's main connected component.
const CASES: Case[] = [
  { name: 'Centre → El Palo', start: [-4.418, 36.72], end: [-4.376, 36.719] },
  { name: 'Alameda → Huelin', start: [-4.423, 36.7205], end: [-4.452, 36.713] },
  { name: 'Pedregalejo → Bulevar', start: [-4.36135, 36.71911], end: [-4.3853, 36.72861] },
  { name: 'Teatinos → Carretera de Cádiz', start: [-4.47862, 36.728], end: [-4.44781, 36.73146] },
  { name: 'Centre → Ciudad Jardín', start: [-4.41648, 36.72466], end: [-4.39552, 36.73265] },
  { name: 'Puerto → Cruz de Humilladero', start: [-4.417, 36.716], end: [-4.443, 36.719] },
  { name: 'Misericordia → Centre', start: [-4.448, 36.714], end: [-4.422, 36.719] },
];

// Thresholds are deliberately slack: OSM changes weekly and a pair may fall out
// of the main component. They are set to catch a regression of the *kind* #5
// was — pavements or sharrows counting as lanes — not to pin exact numbers.
// Measured at the time of writing: 69% bike infrastructure, 1.5% pavement.
const MIN_ROUTED = 5;
const MIN_BIKE_SHARE = 0.55;
const MAX_FOOT_SHARE = 0.1;

const FOOT_CLASSES: EdgeClass[] = ['footway', 'path'];

function main(): void {
  const bin = readFileSync(join(process.cwd(), 'data', 'graph.bin'));
  const buf = new ArrayBuffer(bin.byteLength);
  new Uint8Array(buf).set(bin);
  const graph = decodeGraph(buf);
  const dataset = new Dataset(graph.nodes, graph.edges);
  console.log(
    `· graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${dataset.components} component(s)`,
  );

  const total: Partial<Record<EdgeClass, number>> = {};
  let routed = 0;
  let distance = 0;

  for (const c of CASES) {
    let result: RouteResult;
    try {
      result = dataset.route({
        start: c.start,
        end: c.end,
        p: DEFAULT_PREFERENCE,
        profile: null,
      });
    } catch (err) {
      console.log(`  ⚠ ${c.name}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    routed++;
    distance += result.distance_m;
    for (const [cls, len] of Object.entries(result.classBreakdown) as [EdgeClass, number][]) {
      total[cls] = (total[cls] ?? 0) + len;
    }
    const bike = share(result.classBreakdown, (cls) => isBike(cls));
    console.log(
      `  ${c.name}: ${Math.round(result.distance_m)} m, ${(bike * 100).toFixed(1)}% bike infrastructure`,
    );
  }

  const bikeShare = share(total, (cls) => isBike(cls));
  const footShare = share(total, (cls) => FOOT_CLASSES.includes(cls));
  console.log(
    `\n${routed}/${CASES.length} routed · ${(distance / 1000).toFixed(1)} km · ` +
      `${(bikeShare * 100).toFixed(1)}% bike infrastructure · ${(footShare * 100).toFixed(1)}% pavement`,
  );
  console.log(`  breakdown: ${summarize(total)}`);

  const failures: string[] = [];
  // Guard against passing on stale data: a graph built before the #5
  // classification fix has no `footway` edges at all, because every pavement
  // was still labelled `path`.
  if (!graph.edges.some((e) => classFromId(e.cls) === 'footway'))
    failures.push('graph contains no `footway` edges — /data predates the #5 classification fix');
  if (routed < MIN_ROUTED) failures.push(`only ${routed}/${CASES.length} pairs routed`);
  if (bikeShare < MIN_BIKE_SHARE)
    failures.push(
      `bike-infrastructure share ${(bikeShare * 100).toFixed(1)}% < ${MIN_BIKE_SHARE * 100}%`,
    );
  if (footShare > MAX_FOOT_SHARE)
    failures.push(`pavement share ${(footShare * 100).toFixed(1)}% > ${MAX_FOOT_SHARE * 100}%`);

  if (failures.length > 0) {
    console.error('\n✗ Routing check failed:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✓ Routing check passed — routes follow the bike network.');
}

function share(
  breakdown: Partial<Record<EdgeClass, number>>,
  pick: (cls: EdgeClass) => boolean,
): number {
  let matched = 0;
  let all = 0;
  for (const [cls, len] of Object.entries(breakdown) as [EdgeClass, number][]) {
    all += len;
    if (pick(cls)) matched += len;
  }
  return all > 0 ? matched / all : 0;
}

function summarize(breakdown: Partial<Record<EdgeClass, number>>): string {
  return (Object.entries(breakdown) as [EdgeClass, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([cls, len]) => `${cls} ${Math.round(len)} m`)
    .join(', ');
}

main();
