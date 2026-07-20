// Binary (de)serialization for the prebuilt routing graph and coord store.
// Isomorphic: used by the offline pipeline (Node) and the routing/search
// workers (browser). Little-endian throughout. (SPEC §7.1, §9.3)

export interface GraphNode {
  lon: number;
  lat: number;
}

export interface GraphEdge {
  a: number; // node id
  b: number; // node id
  len: number; // metres
  cls: number; // edge class id (see classes.ts)
  one: number; // 0 both, 1 a→b, -1 b→a
}

export interface ParsedGraph {
  version: number;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const GRAPH_MAGIC = 'BNG1';
const GRAPH_VERSION = 1;
const NODE_BYTES = 8; // 2 × f32
const EDGE_BYTES = 14; // u32 + u32 + f32 + u8 + i8
const GRAPH_HEADER_BYTES = 4 /*magic*/ + 2 /*ver*/ + 4 /*nodes*/ + 4 /*edges*/ + 16 /*bbox*/;

function writeMagic(view: DataView, offset: number, magic: string): void {
  for (let i = 0; i < magic.length; i++) view.setUint8(offset + i, magic.charCodeAt(i));
}

function readMagic(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export function encodeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  bbox: [number, number, number, number],
): ArrayBuffer {
  const size = GRAPH_HEADER_BYTES + nodes.length * NODE_BYTES + edges.length * EDGE_BYTES;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  let o = 0;
  writeMagic(view, o, GRAPH_MAGIC);
  o += 4;
  view.setUint16(o, GRAPH_VERSION, true);
  o += 2;
  view.setUint32(o, nodes.length, true);
  o += 4;
  view.setUint32(o, edges.length, true);
  o += 4;
  for (let i = 0; i < 4; i++) {
    view.setFloat32(o, bbox[i], true);
    o += 4;
  }
  for (const n of nodes) {
    view.setFloat32(o, n.lon, true);
    o += 4;
    view.setFloat32(o, n.lat, true);
    o += 4;
  }
  for (const e of edges) {
    view.setUint32(o, e.a, true);
    o += 4;
    view.setUint32(o, e.b, true);
    o += 4;
    view.setFloat32(o, e.len, true);
    o += 4;
    view.setUint8(o, e.cls);
    o += 1;
    view.setInt8(o, e.one);
    o += 1;
  }
  return buf;
}

export function decodeGraph(buf: ArrayBuffer): ParsedGraph {
  const view = new DataView(buf);
  let o = 0;
  const magic = readMagic(view, o, 4);
  o += 4;
  if (magic !== GRAPH_MAGIC) throw new Error(`Bad graph magic: "${magic}"`);
  const version = view.getUint16(o, true);
  o += 2;
  const nodeCount = view.getUint32(o, true);
  o += 4;
  const edgeCount = view.getUint32(o, true);
  o += 4;
  const bbox: [number, number, number, number] = [
    view.getFloat32(o, true),
    view.getFloat32(o + 4, true),
    view.getFloat32(o + 8, true),
    view.getFloat32(o + 12, true),
  ];
  o += 16;
  const nodes: GraphNode[] = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    nodes[i] = { lon: view.getFloat32(o, true), lat: view.getFloat32(o + 4, true) };
    o += NODE_BYTES;
  }
  const edges: GraphEdge[] = new Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    edges[i] = {
      a: view.getUint32(o, true),
      b: view.getUint32(o + 4, true),
      len: view.getFloat32(o + 8, true),
      cls: view.getUint8(o + 12),
      one: view.getInt8(o + 13),
    };
    o += EDGE_BYTES;
  }
  return { version, bbox, nodes, edges };
}

// ---- coords.bin (SPEC §9.3) ------------------------------------------------

const COORDS_MAGIC = 'BNC1';
const COORDS_HEADER_BYTES = 4 /*magic*/ + 4 /*count*/;

/** `coords` is a flat [lon0, lat0, lon1, lat1, ...] array indexed by record id. */
export function encodeCoords(coords: number[] | Float32Array): ArrayBuffer {
  const count = Math.floor(coords.length / 2);
  const buf = new ArrayBuffer(COORDS_HEADER_BYTES + count * 8);
  const view = new DataView(buf);
  writeMagic(view, 0, COORDS_MAGIC);
  view.setUint32(4, count, true);
  const arr = new Float32Array(buf, COORDS_HEADER_BYTES, count * 2);
  arr.set(coords.slice(0, count * 2));
  return buf;
}

export interface CoordStore {
  count: number;
  get(id: number): [number, number] | null;
}

export function decodeCoords(buf: ArrayBuffer): CoordStore {
  const view = new DataView(buf);
  const magic = readMagic(view, 0, 4);
  if (magic !== COORDS_MAGIC) throw new Error(`Bad coords magic: "${magic}"`);
  const count = view.getUint32(4, true);
  const arr = new Float32Array(buf, COORDS_HEADER_BYTES, count * 2);
  return {
    count,
    get(id: number) {
      if (id < 0 || id >= count) return null;
      return [arr[id * 2], arr[id * 2 + 1]];
    },
  };
}
