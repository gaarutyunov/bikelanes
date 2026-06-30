// Deterministic line network → routing graph builder (SPEC §6 Stage 2, §11).
// Isomorphic: used by the offline pipeline (Node) and import.worker (browser).
// Pipeline: merge → node (split at intersections) → snap (cluster within
// tolerance) → class-tag → drop excluded → measure length → emit nodes+edges.

import type { Feature, FeatureCollection, LineString } from 'geojson';
import Flatbush from 'flatbush';
import { CLASS_ID, EDGE_CLASSES, EXCLUDED_HIGHWAYS, type EdgeClass } from './classes';
import type { GraphEdge, GraphNode } from './graphFormat';
import { haversine } from './geo';

const segBox = (s: { p0: [number, number]; p1: [number, number] }) => ({
  minX: Math.min(s.p0[0], s.p1[0]),
  minY: Math.min(s.p0[1], s.p1[1]),
  maxX: Math.max(s.p0[0], s.p1[0]),
  maxY: Math.max(s.p0[1], s.p1[1]),
});

export interface BuildOptions {
  tolerance_m?: number; // snap tolerance, default 12 m (SPEC §6 Stage 2.4)
  defaultClass?: EdgeClass; // class when a feature has none, default 'path'
}

export interface BuildResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  components: number;
  warnings: string[];
}

interface Seg {
  p0: [number, number];
  p1: [number, number];
  cls: EdgeClass;
  one: number; // 0 both, 1 p0→p1
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function classOf(props: Record<string, unknown> | null, fallback: EdgeClass): EdgeClass {
  const raw = props?.cls ?? props?.class;
  if (typeof raw === 'string' && (EDGE_CLASSES as string[]).includes(raw)) {
    return raw as EdgeClass;
  }
  // Map common OSM highway values when present.
  const hw = props?.highway;
  if (typeof hw === 'string') {
    if (hw === 'cycleway') return 'cycleway';
    if ((EDGE_CLASSES as string[]).includes(hw)) return hw as EdgeClass;
  }
  return fallback;
}

function isExcluded(props: Record<string, unknown> | null): boolean {
  const hw = props?.highway;
  if (typeof hw === 'string' && EXCLUDED_HIGHWAYS.has(hw)) return true;
  if (props?.bicycle === 'no' || props?.access === 'no') return true;
  return false;
}

function onewayOf(props: Record<string, unknown> | null): number {
  const o = props?.oneway;
  if (o === true || o === 'yes' || o === 1 || o === '1') return 1;
  if (o === -1 || o === '-1' || o === 'reverse') return -1;
  return 0;
}

// Segment–segment intersection in planar lon/lat (adequate at city scale).
// Returns the interior intersection params (t on A, u on B) or null.
function intersectParams(
  a0: [number, number],
  a1: [number, number],
  b0: [number, number],
  b1: [number, number],
): { t: number; u: number } | null {
  const rx = a1[0] - a0[0];
  const ry = a1[1] - a0[1];
  const sx = b1[0] - b0[0];
  const sy = b1[1] - b0[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-15) return null; // parallel/collinear
  const qpx = b0[0] - a0[0];
  const qpy = b0[1] - a0[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  const eps = 1e-9;
  if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) return { t, u };
  return null;
}

// Project point onto segment [a,b]; returns param t∈[0,1] and planar distance (m).
function projectParam(
  a: [number, number],
  b: [number, number],
  p: [number, number],
): { t: number; dist_m: number } | null {
  const lat0 = (p[1] * Math.PI) / 180;
  const mx = Math.cos(lat0) * 111320;
  const my = 110540;
  const ax = a[0] * mx,
    ay = a[1] * my,
    bx = b[0] * mx,
    by = b[1] * my,
    px = p[0] * mx,
    py = p[1] * my;
  const dx = bx - ax,
    dy = by - ay;
  const seg2 = dx * dx + dy * dy;
  if (seg2 === 0) return null;
  const t = ((px - ax) * dx + (py - ay) * dy) / seg2;
  const projx = ax + t * dx;
  const projy = ay + t * dy;
  const dist_m = Math.hypot(px - projx, py - projy);
  return { t, dist_m };
}

export function buildGraph(fc: FeatureCollection, opts: BuildOptions = {}): BuildResult {
  const tolerance = opts.tolerance_m ?? 12;
  const fallback = opts.defaultClass ?? 'path';
  const warnings: string[] = [];

  // 1. Flatten features into straight segments, dropping excluded ones.
  const segs: Seg[] = [];
  let dropped = 0;
  for (const f of fc.features as Feature[]) {
    if (!f.geometry || f.geometry.type !== 'LineString') continue;
    const props = (f.properties ?? null) as Record<string, unknown> | null;
    if (isExcluded(props)) {
      dropped++;
      continue;
    }
    const cls = classOf(props, fallback);
    const one = onewayOf(props);
    const coords = (f.geometry as LineString).coordinates;
    for (let i = 1; i < coords.length; i++) {
      const p0: [number, number] = [round6(coords[i - 1][0]), round6(coords[i - 1][1])];
      const p1: [number, number] = [round6(coords[i][0]), round6(coords[i][1])];
      if (p0[0] === p1[0] && p0[1] === p1[1]) continue;
      segs.push({ p0, p1, cls, one });
    }
  }
  if (dropped > 0) warnings.push(`Dropped ${dropped} excluded feature(s).`);

  // 2. Node the topology: split segments at interior intersections (X crossings)
  //    AND at any other segment's endpoint that lands on this segment's interior
  //    (T-junctions) — turf.lineSplit handles both; we replicate that here.
  //    Spatial indexes prune candidate pairs so this scales to city-size input.
  const splitParams: number[][] = segs.map(() => []);
  if (segs.length > 0) {
    const segIndex = new Flatbush(segs.length);
    for (const s of segs) {
      const b = segBox(s);
      segIndex.add(b.minX, b.minY, b.maxX, b.maxY);
    }
    segIndex.finish();

    // X crossings: only test bbox-overlapping pairs.
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const b = segBox(s);
      for (const j of segIndex.search(b.minX, b.minY, b.maxX, b.maxY)) {
        if (j <= i) continue;
        const hit = intersectParams(s.p0, s.p1, segs[j].p0, segs[j].p1);
        if (hit) {
          splitParams[i].push(hit.t);
          splitParams[j].push(hit.u);
        }
      }
    }

    // T-junctions: index distinct vertices, split a segment where a foreign
    // vertex lands on its interior.
    const verts: [number, number][] = [];
    const vertSeen = new Set<string>();
    for (const s of segs) {
      for (const p of [s.p0, s.p1]) {
        const key = `${p[0]},${p[1]}`;
        if (!vertSeen.has(key)) {
          vertSeen.add(key);
          verts.push(p);
        }
      }
    }
    const vIndex = new Flatbush(verts.length);
    for (const v of verts) vIndex.add(v[0], v[1], v[0], v[1]);
    vIndex.finish();
    const T_EPS_M = 1.0; // a vertex this close to a segment interior splits it
    const tEpsDeg = T_EPS_M / 80000; // generous degree padding (covers lon at Málaga lat)
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const b = segBox(s);
      for (const vi of vIndex.search(
        b.minX - tEpsDeg,
        b.minY - tEpsDeg,
        b.maxX + tEpsDeg,
        b.maxY + tEpsDeg,
      )) {
        const v = verts[vi];
        if ((v[0] === s.p0[0] && v[1] === s.p0[1]) || (v[0] === s.p1[0] && v[1] === s.p1[1])) continue;
        const proj = projectParam(s.p0, s.p1, v);
        if (proj && proj.t > 1e-9 && proj.t < 1 - 1e-9 && proj.dist_m <= T_EPS_M) {
          splitParams[i].push(proj.t);
        }
      }
    }
  }
  const subSegs: Seg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = Array.from(new Set([0, ...splitParams[i], 1])).sort((a, b) => a - b);
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1];
      const t1 = ts[k];
      const a: [number, number] = [
        round6(s.p0[0] + (s.p1[0] - s.p0[0]) * t0),
        round6(s.p0[1] + (s.p1[1] - s.p0[1]) * t0),
      ];
      const b: [number, number] = [
        round6(s.p0[0] + (s.p1[0] - s.p0[0]) * t1),
        round6(s.p0[1] + (s.p1[1] - s.p0[1]) * t1),
      ];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      subSegs.push({ p0: a, p1: b, cls: s.cls, one: s.one });
    }
  }

  // 3. Assign node ids by exact (rounded) coordinate.
  const nodeKey = (p: [number, number]) => `${p[0]},${p[1]}`;
  const idByKey = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const idOf = (p: [number, number]): number => {
    const key = nodeKey(p);
    let id = idByKey.get(key);
    if (id === undefined) {
      id = nodes.length;
      idByKey.set(key, id);
      nodes.push({ lon: p[0], lat: p[1] });
    }
    return id;
  };
  for (const s of subSegs) {
    idOf(s.p0);
    idOf(s.p1);
  }

  // 4. Snap: cluster nodes within tolerance, remapping to a representative.
  //    A spatial index restricts each node to nearby candidates (SPEC §6 Stage
  //    2.4 "node-snap pass over an rbush/flatbush spatial index"; §20.1).
  const remap = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) remap[i] = i;
  const findRep = (x: number): number => {
    while (remap[x] !== x) {
      remap[x] = remap[remap[x]];
      x = remap[x];
    }
    return x;
  };
  if (tolerance > 0 && nodes.length > 0) {
    const nIndex = new Flatbush(nodes.length);
    for (const n of nodes) nIndex.add(n.lon, n.lat, n.lon, n.lat);
    nIndex.finish();
    for (let i = 0; i < nodes.length; i++) {
      const ni = nodes[i];
      const dLat = tolerance / 110540;
      const dLon = tolerance / (111320 * Math.max(0.1, Math.cos((ni.lat * Math.PI) / 180)));
      for (const j of nIndex.search(ni.lon - dLon, ni.lat - dLat, ni.lon + dLon, ni.lat + dLat)) {
        if (j <= i || findRep(i) === findRep(j)) continue;
        const d = haversine([ni.lon, ni.lat], [nodes[j].lon, nodes[j].lat]);
        if (d > 0 && d <= tolerance) remap[findRep(j)] = findRep(i);
      }
    }
  }

  // 5. Emit edges with measured length, de-duplicating and dropping self-loops.
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const s of subSegs) {
    const a = findRep(idOf(s.p0));
    const b = findRep(idOf(s.p1));
    if (a === b) continue;
    const key = a < b ? `${a}|${b}|${s.cls}` : `${b}|${a}|${s.cls}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const len = haversine([nodes[a].lon, nodes[a].lat], [nodes[b].lon, nodes[b].lat]);
    edges.push({ a, b, len, cls: CLASS_ID[s.cls], one: s.one });
  }

  // 6. Compact node ids (some may be unreferenced after clustering).
  const used = new Map<number, number>();
  const compactNodes: GraphNode[] = [];
  const compactId = (rep: number): number => {
    let id = used.get(rep);
    if (id === undefined) {
      id = compactNodes.length;
      used.set(rep, id);
      compactNodes.push(nodes[rep]);
    }
    return id;
  };
  const compactEdges: GraphEdge[] = edges.map((e) => ({
    ...e,
    a: compactId(e.a),
    b: compactId(e.b),
  }));

  // 7. Snap dangling endpoints onto the nearest edge within tolerance — connects
  //    parallel infrastructure (e.g. a segregated cycleway ending mid-block next
  //    to a road) that shares no exact vertex (SPEC §6.2.4). This is the main
  //    de-fragmentation pass; node-to-node clustering alone misses these.
  const snapped = snapDanglingToEdges(compactNodes, compactEdges, tolerance);

  const components = countComponents(snapped.nodes.length, snapped.edges);
  if (components > 1) warnings.push(`${components} disconnected components.`);

  return { nodes: snapped.nodes, edges: snapped.edges, components, warnings };
}

// Length (m) of a straight segment a→b between params t0 and t1.
function subLen(a: GraphNode, b: GraphNode, t0: number, t1: number): number {
  const p0: [number, number] = [a.lon + (b.lon - a.lon) * t0, a.lat + (b.lat - a.lat) * t0];
  const p1: [number, number] = [a.lon + (b.lon - a.lon) * t1, a.lat + (b.lat - a.lat) * t1];
  return haversine(p0, p1);
}

function snapDanglingToEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
  tolerance: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (tolerance <= 0 || edges.length === 0) return { nodes, edges };

  const deg = new Int32Array(nodes.length);
  for (const e of edges) {
    deg[e.a]++;
    deg[e.b]++;
  }

  const fb = new Flatbush(edges.length);
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    fb.add(
      Math.min(a.lon, b.lon),
      Math.min(a.lat, b.lat),
      Math.max(a.lon, b.lon),
      Math.max(a.lat, b.lat),
    );
  }
  fb.finish();

  const tolLat = tolerance / 110540;
  const cuts = new Map<number, { t: number; node: number }[]>(); // edge index → cut points
  const directConnectors: GraphEdge[] = []; // snap straight to an existing endpoint

  for (let n = 0; n < nodes.length; n++) {
    if (deg[n] !== 1) continue; // only dangling endpoints
    const pn = nodes[n];
    const tolLon = tolerance / (111320 * Math.max(0.1, Math.cos((pn.lat * Math.PI) / 180)));
    let best: { ei: number; t: number; dist: number } | null = null;
    for (const ei of fb.search(pn.lon - tolLon, pn.lat - tolLat, pn.lon + tolLon, pn.lat + tolLat)) {
      const e = edges[ei];
      if (e.a === n || e.b === n) continue;
      const a = nodes[e.a];
      const b = nodes[e.b];
      const proj = projectParam([a.lon, a.lat], [b.lon, b.lat], [pn.lon, pn.lat]);
      if (!proj) continue;
      const t = Math.max(0, Math.min(1, proj.t));
      const lon = a.lon + (b.lon - a.lon) * t;
      const lat = a.lat + (b.lat - a.lat) * t;
      const dist = haversine([pn.lon, pn.lat], [lon, lat]);
      if (dist <= tolerance && (!best || dist < best.dist)) best = { ei, t, dist };
    }
    if (!best || best.dist < 1e-6) continue;
    const e = edges[best.ei];
    if (best.t <= 1e-6) {
      directConnectors.push(connector(n, e.a, nodes));
    } else if (best.t >= 1 - 1e-6) {
      directConnectors.push(connector(n, e.b, nodes));
    } else {
      const list = cuts.get(best.ei) ?? [];
      list.push({ t: best.t, node: n });
      cuts.set(best.ei, list);
    }
  }

  if (cuts.size === 0 && directConnectors.length === 0) return { nodes, edges };

  const outNodes = nodes.slice();
  const outEdges: GraphEdge[] = [];
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const cs = cuts.get(ei);
    if (!cs) {
      outEdges.push(e);
      continue;
    }
    cs.sort((x, y) => x.t - y.t);
    const a = nodes[e.a];
    const b = nodes[e.b];
    let prevId = e.a;
    let prevT = 0;
    for (const c of cs) {
      const lon = a.lon + (b.lon - a.lon) * c.t;
      const lat = a.lat + (b.lat - a.lat) * c.t;
      const mid = outNodes.length;
      outNodes.push({ lon, lat });
      outEdges.push({ a: prevId, b: mid, len: subLen(a, b, prevT, c.t), cls: e.cls, one: e.one });
      const dn = nodes[c.node];
      outEdges.push({
        a: c.node,
        b: mid,
        len: haversine([dn.lon, dn.lat], [lon, lat]),
        cls: CLASS_ID.connector,
        one: 0,
      });
      prevId = mid;
      prevT = c.t;
    }
    outEdges.push({ a: prevId, b: e.b, len: subLen(a, b, prevT, 1), cls: e.cls, one: e.one });
  }
  outEdges.push(...directConnectors);
  return { nodes: outNodes, edges: outEdges };
}

function connector(from: number, to: number, nodes: GraphNode[]): GraphEdge {
  return {
    a: from,
    b: to,
    len: haversine([nodes[from].lon, nodes[from].lat], [nodes[to].lon, nodes[to].lat]),
    cls: CLASS_ID.connector,
    one: 0,
  };
}

export function countComponents(nodeCount: number, edges: GraphEdge[]): number {
  if (nodeCount === 0) return 0;
  const parent = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const roots = new Set<number>();
  for (let i = 0; i < nodeCount; i++) roots.add(find(i));
  return roots.size;
}
