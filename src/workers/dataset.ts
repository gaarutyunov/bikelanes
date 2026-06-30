// Routing dataset: an ngraph graph + flatbush spatial index + edge geometry,
// with endpoint snapping (SPEC §7.5) and NBA* routing (SPEC §7.4).

import createGraph, { type Graph, type Node, type Link } from 'ngraph.graph';
import { nba } from 'ngraph.path';
import Flatbush from 'flatbush';
import { classFromId, isBike, type EdgeClass } from '../core/classes';
import { routingCost } from '../core/preference';
import { routeEta } from '../core/eta';
import { haversine } from '../core/geo';
import type { GraphEdge, GraphNode } from '../core/graphFormat';
import type { RouteRequest, RouteResult, RouteStep, SpeedProfile } from '../core/types';

interface NodeData {
  lon: number;
  lat: number;
}
interface LinkData {
  len: number;
  cls: number;
}

interface EdgeGeom {
  a: number;
  b: number;
  cls: number;
  one: number;
  aLon: number;
  aLat: number;
  bLon: number;
  bLat: number;
}

// Fastest prior speed (m/s) — used to keep the A* heuristic admissible.
const MAX_SPEED_MS = (18 * 1000) / 3600;

interface Projection {
  edge: EdgeGeom;
  lon: number;
  lat: number;
  dist_m: number;
  lenA: number; // metres from node a to projected point
  lenB: number; // metres from projected point to node b
}

export class Dataset {
  graph: Graph<NodeData, LinkData>;
  edges: EdgeGeom[];
  nodes: GraphNode[];
  private index: Flatbush;
  components: number;

  constructor(nodes: GraphNode[], edges: GraphEdge[]) {
    this.nodes = nodes;
    this.graph = createGraph<NodeData, LinkData>({ multigraph: true });
    for (let i = 0; i < nodes.length; i++) {
      this.graph.addNode(i, { lon: nodes[i].lon, lat: nodes[i].lat });
    }
    this.edges = new Array(edges.length);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const na = nodes[e.a];
      const nb = nodes[e.b];
      this.edges[i] = {
        a: e.a,
        b: e.b,
        cls: e.cls,
        one: e.one,
        aLon: na.lon,
        aLat: na.lat,
        bLon: nb.lon,
        bLat: nb.lat,
      };
      const fwd = e.one >= 0; // 0 both, 1 a→b
      const bwd = e.one <= 0; // 0 both, -1 b→a
      if (fwd) this.graph.addLink(e.a, e.b, { len: e.len, cls: e.cls });
      if (bwd) this.graph.addLink(e.b, e.a, { len: e.len, cls: e.cls });
    }
    this.index = this.buildIndex();
    this.components = this.countComponents();
  }

  private buildIndex(): Flatbush {
    const n = Math.max(1, this.edges.length);
    const fb = new Flatbush(n);
    if (this.edges.length === 0) {
      fb.add(0, 0, 0, 0); // flatbush requires ≥1 item
    } else {
      for (const e of this.edges) {
        fb.add(
          Math.min(e.aLon, e.bLon),
          Math.min(e.aLat, e.bLat),
          Math.max(e.aLon, e.bLon),
          Math.max(e.aLat, e.bLat),
        );
      }
    }
    fb.finish();
    return fb;
  }

  private countComponents(): number {
    const parent = new Int32Array(this.nodes.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    for (const e of this.edges) union(e.a, e.b);
    const roots = new Set<number>();
    for (let i = 0; i < parent.length; i++) roots.add(find(i));
    return roots.size;
  }

  /** Project a point onto the nearest edge (SPEC §7.5). */
  private snap(point: [number, number]): Projection | null {
    if (this.edges.length === 0) return null;
    const k = Math.min(this.edges.length, 25);
    const cand = this.index.neighbors(point[0], point[1], k);
    let best: Projection | null = null;
    const lat0 = (point[1] * Math.PI) / 180;
    const mx = Math.cos(lat0) * 111320;
    const my = 110540;
    for (const ei of cand) {
      const e = this.edges[ei];
      const ax = e.aLon * mx;
      const ay = e.aLat * my;
      const bx = e.bLon * mx;
      const by = e.bLat * my;
      const px = point[0] * mx;
      const py = point[1] * my;
      const dx = bx - ax;
      const dy = by - ay;
      const seg2 = dx * dx + dy * dy;
      let t = seg2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / seg2 : 0;
      t = Math.max(0, Math.min(1, t));
      const lon = e.aLon + t * (e.bLon - e.aLon);
      const lat = e.aLat + t * (e.bLat - e.aLat);
      const dist = haversine(point, [lon, lat]);
      if (!best || dist < best.dist_m) {
        const lenA = haversine([e.aLon, e.aLat], [lon, lat]);
        const lenB = haversine([lon, lat], [e.bLon, e.bLat]);
        best = { edge: e, lon, lat, dist_m: dist, lenA, lenB };
      }
    }
    return best;
  }

  /** Insert a temporary node splitting its host edge; returns the temp id. */
  private addTempNode(id: string, proj: Projection): void {
    const e = proj.edge;
    this.graph.addNode(id, { lon: proj.lon, lat: proj.lat });
    const fwd = e.one >= 0;
    const bwd = e.one <= 0;
    // a → temp → b for the forward direction; b → temp → a for the reverse.
    if (fwd) {
      this.graph.addLink(e.a, id, { len: proj.lenA, cls: e.cls });
      this.graph.addLink(id, e.b, { len: proj.lenB, cls: e.cls });
    }
    if (bwd) {
      this.graph.addLink(e.b, id, { len: proj.lenB, cls: e.cls });
      this.graph.addLink(id, e.a, { len: proj.lenA, cls: e.cls });
    }
  }

  route(req: RouteRequest): RouteResult {
    const sProj = this.snap(req.start);
    const eProj = this.snap(req.end);
    if (!sProj || !eProj) throw new Error('No routable network near the chosen points.');

    this.addTempNode('S', sProj);
    this.addTempNode('E', eProj);

    // If both endpoints landed on the same host edge, add a direct temp link so
    // very short same-segment routes don't have to detour via a shared vertex.
    if (sProj.edge === eProj.edge) {
      const len = haversine([sProj.lon, sProj.lat], [eProj.lon, eProj.lat]);
      const e = sProj.edge;
      const sBeforeE = sProj.lenA <= eProj.lenA;
      if (e.one >= 0 && sBeforeE) this.graph.addLink('S', 'E', { len, cls: e.cls });
      else if (e.one >= 0 && !sBeforeE) this.graph.addLink('E', 'S', { len, cls: e.cls });
      if (e.one <= 0 && sBeforeE) this.graph.addLink('E', 'S', { len, cls: e.cls });
      else if (e.one <= 0 && !sBeforeE) this.graph.addLink('S', 'E', { len, cls: e.cls });
    }

    try {
      const p = req.p;
      const finder = nba<NodeData, LinkData>(this.graph, {
        oriented: true,
        distance: (_a, _b, link: Link<LinkData>) => {
          const d = link.data;
          return routingCost(d.len, classFromId(d.cls), p);
        },
        heuristic: (a: Node<NodeData>, b: Node<NodeData>) => {
          return haversine([a.data.lon, a.data.lat], [b.data.lon, b.data.lat]) / MAX_SPEED_MS;
        },
      });
      const pathNodes = finder.find('S', 'E');
      if (!pathNodes || pathNodes.length === 0) {
        throw new Error('No route found between these points with the current network.');
      }
      // find() returns nodes from target → source; reverse to source → target.
      const ordered = pathNodes.slice().reverse();
      return this.buildResult(ordered, req.profile);
    } finally {
      this.graph.removeNode('S');
      this.graph.removeNode('E');
    }
  }

  private buildResult(
    nodesInOrder: Array<Node<NodeData>>,
    profile: SpeedProfile | null,
  ): RouteResult {
    const coords: [number, number][] = [];
    const classBreakdown: Partial<Record<EdgeClass, number>> = {};
    const steps: RouteStep[] = [];
    const segments: SegmentFeature[] = [];
    let distance = 0;
    let roadDistance = 0;

    const first: [number, number] = [nodesInOrder[0].data.lon, nodesInOrder[0].data.lat];
    coords.push(first);
    // Accumulate consecutive same-surface edges into one polyline feature so the
    // route renders as continuous bike-vs-road coloured runs (SPEC §10).
    let run: [number, number][] = [first];
    let runKind: 'bike' | 'road' | null = null;
    const flush = () => {
      if (runKind && run.length > 1) {
        segments.push({
          type: 'Feature',
          properties: { kind: runKind },
          geometry: { type: 'LineString', coordinates: run.map((c) => [c[0], c[1]]) },
        });
      }
    };

    for (let i = 1; i < nodesInOrder.length; i++) {
      const u = nodesInOrder[i - 1];
      const v = nodesInOrder[i];
      const p: [number, number] = [v.data.lon, v.data.lat];
      coords.push(p);
      const link = this.graph.getLink(u.id, v.id) ?? this.graph.getLink(v.id, u.id);
      const data: LinkData | undefined = link?.data;
      const len = data ? data.len : haversine([u.data.lon, u.data.lat], [v.data.lon, v.data.lat]);
      const cls = classFromId(data ? data.cls : 10);
      const kind: 'bike' | 'road' = isBike(cls) ? 'bike' : 'road';
      distance += len;
      if (kind === 'road') roadDistance += len;
      classBreakdown[cls] = (classBreakdown[cls] ?? 0) + len;
      const last = steps[steps.length - 1];
      if (last && last.cls === cls) last.distance_m += len;
      else steps.push({ cls, distance_m: len, text: '' });

      if (runKind === null) runKind = kind;
      if (kind !== runKind) {
        flush();
        run = [[u.data.lon, u.data.lat]]; // start new run at the junction
        runKind = kind;
      }
      run.push(p);
    }
    flush();
    for (const s of steps) s.text = stepText(s.cls, s.distance_m);

    const { eta_s, etaSource } = routeEta(classBreakdown, profile);
    return {
      geometry: { type: 'LineString', coordinates: coords },
      segments: { type: 'FeatureCollection', features: segments },
      distance_m: distance,
      eta_s,
      etaSource,
      steps,
      classBreakdown,
      usedRoadShare: distance > 0 ? roadDistance / distance : 0,
    };
  }
}

type SegmentFeature = {
  type: 'Feature';
  properties: { kind: 'bike' | 'road' };
  geometry: { type: 'LineString'; coordinates: number[][] };
};

const CLASS_LABEL: Record<EdgeClass, string> = {
  cycleway: 'segregated cycle track',
  cycle_lane: 'on-road cycle lane',
  cycle_street: 'bike-priority street',
  path: 'shared path',
  living_street: 'calmed street',
  residential: 'residential road',
  tertiary: 'minor road',
  secondary: 'secondary road',
  primary: 'main road',
  link: 'ramp',
  connector: 'connecting street',
};

function stepText(cls: EdgeClass, dist: number): string {
  const m = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;
  return `Continue on ${CLASS_LABEL[cls]} for ${m}`;
}
