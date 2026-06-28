/// <reference lib="webworker" />
// Routing worker: loads graph.bin, builds an ngraph + spatial index, answers
// route requests with the live preference penalty and personalized ETA, and
// supports user-GeoJSON import (route-on / merge). (SPEC §4, §7, §11)

import Flatbush from 'flatbush';
import { decodeGraph, type GraphEdge, type GraphNode } from '../core/graphFormat';
import { fetchArrayBuffer } from '../core/fetchArtifact';
import { CLASS_ID } from '../core/classes';
import { haversine } from '../core/geo';
import { Dataset } from './dataset';
import type { RoutingIn, RoutingOut } from './protocol';

let baseNodes: GraphNode[] = [];
let baseEdges: GraphEdge[] = [];
let base: Dataset | null = null;
let active: Dataset | null = null;

const post = (msg: RoutingOut) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = async (ev: MessageEvent<RoutingIn>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'load': {
        const buf = await fetchArrayBuffer(msg.graphUrl);
        const g = decodeGraph(buf);
        baseNodes = g.nodes;
        baseEdges = g.edges;
        base = new Dataset(baseNodes, baseEdges);
        active = base;
        post({
          type: 'ready',
          nodeCount: g.nodes.length,
          edgeCount: g.edges.length,
          components: base.components,
        });
        break;
      }
      case 'route': {
        if (!active) throw new Error('Routing graph not loaded yet.');
        try {
          const result = active.route(msg.req);
          post({ type: 'route', id: msg.id, ok: true, result });
        } catch (err) {
          post({ type: 'route', id: msg.id, ok: false, error: errMsg(err) });
        }
        break;
      }
      case 'loadImport': {
        handleImport(msg.nodes, msg.edges, msg.merge, msg.tolerance_m);
        break;
      }
      case 'clearImport': {
        active = base;
        post({ type: 'import', ok: true, components: base?.components ?? 0 });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', error: errMsg(err) });
  }
};

function handleImport(
  impNodes: GraphNode[],
  impEdges: GraphEdge[],
  merge: boolean,
  tolerance_m: number,
): void {
  if (impNodes.length === 0 || impEdges.length === 0) {
    post({ type: 'import', ok: false, components: 0, error: 'Imported network is empty.' });
    return;
  }

  if (!merge || !base) {
    // Route purely on the imported network.
    active = new Dataset(impNodes, impEdges);
    post({
      type: 'import',
      ok: true,
      components: active.components,
      warning: active.components > 1 ? `${active.components} disconnected components.` : undefined,
    });
    return;
  }

  // Merge: concat base + imported (offset ids) + connector edges snapping each
  // imported node to the nearest base node within tolerance (SPEC §11.3).
  const offset = baseNodes.length;
  const nodes: GraphNode[] = baseNodes.concat(impNodes);
  const edges: GraphEdge[] = baseEdges.concat(
    impEdges.map((e) => ({ ...e, a: e.a + offset, b: e.b + offset })),
  );

  const fb = new Flatbush(Math.max(1, baseNodes.length));
  if (baseNodes.length === 0) fb.add(0, 0, 0, 0);
  else for (const n of baseNodes) fb.add(n.lon, n.lat, n.lon, n.lat);
  fb.finish();

  let connectors = 0;
  for (let i = 0; i < impNodes.length; i++) {
    const n = impNodes[i];
    const near = fb.neighbors(n.lon, n.lat, 1);
    if (near.length === 0) continue;
    const bn = baseNodes[near[0]];
    const d = haversine([n.lon, n.lat], [bn.lon, bn.lat]);
    if (d <= tolerance_m) {
      edges.push({ a: near[0], b: i + offset, len: d, cls: CLASS_ID.connector, one: 0 });
      connectors++;
    }
  }

  active = new Dataset(nodes, edges);
  const warning =
    connectors === 0
      ? 'Imported network did not connect to the Málaga graph within tolerance.'
      : active.components > 1
        ? `${active.components} disconnected components after merge.`
        : undefined;
  post({ type: 'import', ok: true, components: active.components, warning });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
