/// <reference lib="webworker" />
// Import worker: validate user GeoJSON, run the deterministic clean/node/snap/
// class-tag pipeline, and return a prebuilt in-memory graph (SPEC §11).

import type { FeatureCollection } from 'geojson';
import { buildGraph } from '../core/buildGraph';
import { EDGE_CLASSES, type EdgeClass } from '../core/classes';
import type { ImportIn, ImportOut } from './protocol';

const post = (msg: ImportOut) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (ev: MessageEvent<ImportIn>) => {
  const msg = ev.data;
  if (msg.type !== 'process') return;
  try {
    const fc = validate(msg.geojson);
    const lineCount = fc.features.filter(
      (f) => f.geometry && f.geometry.type === 'LineString',
    ).length;
    if (lineCount === 0) {
      throw new Error('No LineString features found. Provide line geometry to route over.');
    }
    const defaultClass = (EDGE_CLASSES as string[]).includes(msg.defaultClass)
      ? (msg.defaultClass as EdgeClass)
      : 'path';
    const built = buildGraph(fc, { tolerance_m: msg.tolerance_m, defaultClass });
    post({
      type: 'done',
      nodes: built.nodes,
      edges: built.edges,
      components: built.components,
      warning: built.warnings.length ? built.warnings.join(' ') : undefined,
      featureCount: lineCount,
    });
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

function validate(input: unknown): FeatureCollection {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid file: not a JSON object.');
  }
  const obj = input as Record<string, unknown>;
  if (obj.type !== 'FeatureCollection' || !Array.isArray(obj.features)) {
    throw new Error('Expected a GeoJSON FeatureCollection.');
  }
  const hasGeom = obj.features.some(
    (f) =>
      f &&
      typeof f === 'object' &&
      (f as { geometry?: { type?: string } }).geometry?.type === 'LineString',
  );
  if (!hasGeom) throw new Error('FeatureCollection contains no LineString geometry.');
  return obj as unknown as FeatureCollection;
}
