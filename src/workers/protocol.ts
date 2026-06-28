// Message protocols between the UI thread and the workers.

import type { GraphEdge, GraphNode } from '../core/graphFormat';
import type { RouteRequest, RouteResult, SpeedProfile } from '../core/types';

// ---- routing.worker --------------------------------------------------------

export type RoutingIn =
  | { type: 'load'; graphUrl: string }
  | { type: 'route'; id: number; req: RouteRequest }
  | {
      type: 'loadImport';
      nodes: GraphNode[];
      edges: GraphEdge[];
      merge: boolean;
      tolerance_m: number;
    }
  | { type: 'clearImport' };

export type RoutingOut =
  | { type: 'ready'; nodeCount: number; edgeCount: number; components: number }
  | { type: 'route'; id: number; ok: true; result: RouteResult }
  | { type: 'route'; id: number; ok: false; error: string }
  | { type: 'import'; ok: boolean; components: number; warning?: string; error?: string }
  | { type: 'error'; error: string };

// ---- search.worker ---------------------------------------------------------

export interface SearchHit {
  id: number;
  display: string;
  street: string;
  number: string;
  postcode: string;
  coord: [number, number] | null;
}

export type SearchIn =
  | { type: 'load'; indexUrl: string; coordsUrl: string; metaUrl: string }
  | { type: 'query'; id: number; text: string; limit?: number }
  | { type: 'coord'; id: number; recordId: number };

export type SearchOut =
  | { type: 'ready'; records: number }
  | { type: 'results'; id: number; hits: SearchHit[] }
  | { type: 'coord'; id: number; coord: [number, number] | null }
  | { type: 'error'; error: string };

// ---- import.worker ---------------------------------------------------------

export type ImportIn = {
  type: 'process';
  geojson: unknown;
  tolerance_m: number;
  defaultClass: string;
};

export type ImportOut =
  | {
      type: 'done';
      nodes: GraphNode[];
      edges: GraphEdge[];
      components: number;
      warning?: string;
      featureCount: number;
    }
  | { type: 'error'; error: string };

// Re-export for convenience.
export type { RouteRequest, RouteResult, SpeedProfile };
