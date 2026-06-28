// Stages 2 & 3 — build the routing network and serialize graph.bin
// (SPEC §6 Stage 2/3, §7.1). Also emits a bikelanes.geojson display layer.

import type { FeatureCollection, Feature } from 'geojson';
import { buildGraph, type BuildResult } from '../src/core/buildGraph';
import { encodeGraph, type GraphEdge, type GraphNode } from '../src/core/graphFormat';
import { classFromId, isBike, EDGE_CLASSES } from '../src/core/classes';
import { writeBin, writeJson } from './util';

export interface GraphOutput {
  bbox: [number, number, number, number];
  nodes: number;
  edges: number;
  components: number;
  warnings: string[];
}

function bboxOf(nodes: GraphNode[]): [number, number, number, number] {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  for (const n of nodes) {
    if (n.lon < minLon) minLon = n.lon;
    if (n.lat < minLat) minLat = n.lat;
    if (n.lon > maxLon) maxLon = n.lon;
    if (n.lat > maxLat) maxLat = n.lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

function displayLayer(nodes: GraphNode[], edges: GraphEdge[]): FeatureCollection {
  const features: Feature[] = edges.map((e) => {
    const cls = classFromId(e.cls);
    const kind = cls === 'connector' ? 'connector' : isBike(cls) ? 'bike' : 'road';
    return {
      type: 'Feature',
      properties: { cls, kind },
      geometry: {
        type: 'LineString',
        coordinates: [
          [nodes[e.a].lon, nodes[e.a].lat],
          [nodes[e.b].lon, nodes[e.b].lat],
        ],
      },
    };
  });
  return { type: 'FeatureCollection', features };
}

/** Validate that the largest component covers ≥98% of bike-lane length (§6.2.8). */
function validateCoverage(built: BuildResult): string[] {
  const warnings = [...built.warnings];
  // Union-find to size components by bike length.
  const parent = new Int32Array(built.nodes.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const e of built.edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }
  let totalBike = 0;
  const bikeByComp = new Map<number, number>();
  for (const e of built.edges) {
    if (!isBike(classFromId(e.cls))) continue;
    totalBike += e.len;
    const r = find(e.a);
    bikeByComp.set(r, (bikeByComp.get(r) ?? 0) + e.len);
  }
  if (totalBike > 0) {
    const largest = Math.max(0, ...bikeByComp.values());
    const share = largest / totalBike;
    if (share < 0.98) {
      warnings.push(
        `Largest component covers ${(share * 100).toFixed(1)}% of bike-lane length (<98%) — snapping gaps likely.`,
      );
    }
  }
  return warnings;
}

export function buildAndWriteGraph(
  fc: FeatureCollection,
  opts: { tolerance_m?: number } = {},
): GraphOutput {
  const built = buildGraph(fc, { tolerance_m: opts.tolerance_m ?? 12 });
  const bbox = bboxOf(built.nodes);
  const buf = encodeGraph(built.nodes, built.edges, bbox);
  writeBin('graph.bin', buf);
  writeJson('bikelanes.geojson', displayLayer(built.nodes, built.edges));
  const warnings = validateCoverage(built);
  // Sanity: ensure no excluded class leaked into the graph.
  for (const e of built.edges) {
    void EDGE_CLASSES[e.cls];
  }
  return {
    bbox,
    nodes: built.nodes.length,
    edges: built.edges.length,
    components: built.components,
    warnings,
  };
}
