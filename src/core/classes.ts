// Edge classes & cold-start prior speeds (SPEC §7.2).
// The numeric id is what gets serialized into graph.bin as the `cls` u8.

export type EdgeClass =
  | 'cycleway'
  | 'cycle_lane'
  | 'cycle_street'
  | 'path'
  | 'living_street'
  | 'residential'
  | 'tertiary'
  | 'secondary'
  | 'primary'
  | 'link'
  | 'connector'
  | 'footway'
  | 'shared_lane';

// Ordered list — index === serialized cls id. Never reorder without a graph
// rebuild; append only (`footway` and `shared_lane` were appended, hence their
// position after `connector`).
export const EDGE_CLASSES: EdgeClass[] = [
  'cycleway',
  'cycle_lane',
  'cycle_street',
  'path',
  'living_street',
  'residential',
  'tertiary',
  'secondary',
  'primary',
  'link',
  'connector',
  'footway',
  'shared_lane',
];

export const CLASS_ID: Record<EdgeClass, number> = EDGE_CLASSES.reduce(
  (acc, cls, i) => {
    acc[cls] = i;
    return acc;
  },
  {} as Record<EdgeClass, number>,
);

export function classFromId(id: number): EdgeClass {
  const cls = EDGE_CLASSES[id];
  if (!cls) throw new Error(`Unknown edge class id: ${id}`);
  return cls;
}

// Cold-start prior speeds in km/h (SPEC §7.2).
export const PRIOR_SPEED_KMH: Record<EdgeClass, number> = {
  cycleway: 18,
  cycle_lane: 16,
  cycle_street: 16,
  path: 13,
  living_street: 14,
  residential: 15,
  tertiary: 16,
  secondary: 16,
  primary: 16,
  link: 14,
  connector: 10,
  footway: 10, // pavement / pedestrian street — pedestrian traffic sets the pace
  shared_lane: 16, // sharrow: a bike pictogram in a shared traffic lane
};

export function priorSpeedKmh(cls: EdgeClass): number {
  return PRIOR_SPEED_KMH[cls];
}

// Mean of the class priors — used to scale priors to the rider's overall pace
// when only overall personalization is confident (SPEC §14.1).
export const PRIOR_OVERALL_MEAN_KMH =
  EDGE_CLASSES.reduce((sum, c) => sum + PRIOR_SPEED_KMH[c], 0) / EDGE_CLASSES.length;

// Bike *infrastructure* — somewhere a bike is the intended vehicle. This drives
// the map's lane layer, the route's bike/road colouring and `usedRoadShare`, so
// it must mean exactly what a rider means by "a bike lane".
//
// `path` and `shared_lane` are deliberately excluded. Málaga's OSM extract has
// ~16.5k footway/pedestrian ways against ~1.5k cycleways, and every one of its
// 343 sharrow ways sits on a primary or secondary road; counting either as bike
// infrastructure buried the real lane network in a red mesh and let the router
// treat a pavement — or a main carriageway — as being as good as a cycle
// track (#5).
const BIKE_CLASSES = new Set<EdgeClass>(['cycleway', 'cycle_lane', 'cycle_street']);

export function isBike(cls: EdgeClass): boolean {
  return BIKE_CLASSES.has(cls);
}

// Classes excluded entirely at build time (never enter the graph) — SPEC §7.2.
export const EXCLUDED_HIGHWAYS = new Set(['motorway', 'motorway_link']);
