// Typed worker clients with promise-based request/response correlation.

import type {
  RoutingIn,
  RoutingOut,
  SearchIn,
  SearchOut,
  ImportIn,
  ImportOut,
  SearchHit,
} from '../workers/protocol';
import type { RouteRequest, RouteResult } from '../core/types';
import type { GraphEdge, GraphNode } from '../core/graphFormat';

export class RoutingClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (r: { ok: boolean; result?: RouteResult; error?: string }) => void>();
  private readyResolve: ((info: { components: number }) => void) | null = null;
  private importResolve: ((r: RoutingOut & { type: 'import' }) => void) | null = null;
  onError?: (msg: string) => void;

  constructor() {
    this.worker = new Worker(new URL('../workers/routing.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (ev: MessageEvent<RoutingOut>) => this.handle(ev.data);
  }

  private handle(msg: RoutingOut): void {
    switch (msg.type) {
      case 'ready':
        this.readyResolve?.({ components: msg.components });
        this.readyResolve = null;
        break;
      case 'route': {
        const cb = this.pending.get(msg.id);
        if (cb) {
          this.pending.delete(msg.id);
          cb(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
        }
        break;
      }
      case 'import':
        this.importResolve?.(msg);
        this.importResolve = null;
        break;
      case 'error':
        this.onError?.(msg.error);
        break;
    }
  }

  load(graphUrl: string): Promise<{ components: number }> {
    const p = new Promise<{ components: number }>((res) => (this.readyResolve = res));
    this.send({ type: 'load', graphUrl });
    return p;
  }

  route(req: RouteRequest): Promise<RouteResult> {
    const id = this.nextId++;
    return new Promise<RouteResult>((resolve, reject) => {
      this.pending.set(id, (r) =>
        r.ok && r.result ? resolve(r.result) : reject(new Error(r.error ?? 'Routing failed')),
      );
      this.send({ type: 'route', id, req });
    });
  }

  loadImport(
    nodes: GraphNode[],
    edges: GraphEdge[],
    merge: boolean,
    tolerance_m: number,
  ): Promise<RoutingOut & { type: 'import' }> {
    const p = new Promise<RoutingOut & { type: 'import' }>((res) => (this.importResolve = res));
    this.send({ type: 'loadImport', nodes, edges, merge, tolerance_m });
    return p;
  }

  clearImport(): Promise<RoutingOut & { type: 'import' }> {
    const p = new Promise<RoutingOut & { type: 'import' }>((res) => (this.importResolve = res));
    this.send({ type: 'clearImport' });
    return p;
  }

  private send(msg: RoutingIn): void {
    this.worker.postMessage(msg);
  }
}

export class SearchClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (hits: SearchHit[]) => void>();
  private coordPending = new Map<number, (c: [number, number] | null) => void>();
  private readyResolve: ((records: number) => void) | null = null;
  onError?: (msg: string) => void;

  constructor() {
    this.worker = new Worker(new URL('../workers/search.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (ev: MessageEvent<SearchOut>) => this.handle(ev.data);
  }

  private handle(msg: SearchOut): void {
    switch (msg.type) {
      case 'ready':
        this.readyResolve?.(msg.records);
        this.readyResolve = null;
        break;
      case 'results': {
        const cb = this.pending.get(msg.id);
        if (cb) {
          this.pending.delete(msg.id);
          cb(msg.hits);
        }
        break;
      }
      case 'coord': {
        const cb = this.coordPending.get(msg.id);
        if (cb) {
          this.coordPending.delete(msg.id);
          cb(msg.coord);
        }
        break;
      }
      case 'error':
        this.onError?.(msg.error);
        break;
    }
  }

  load(indexUrl: string, coordsUrl: string, metaUrl: string): Promise<number> {
    const p = new Promise<number>((res) => (this.readyResolve = res));
    this.send({ type: 'load', indexUrl, coordsUrl, metaUrl });
    return p;
  }

  query(text: string, limit = 8): Promise<SearchHit[]> {
    const id = this.nextId++;
    return new Promise<SearchHit[]>((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type: 'query', id, text, limit });
    });
  }

  private send(msg: SearchIn): void {
    this.worker.postMessage(msg);
  }
}

export function processImport(
  geojson: unknown,
  tolerance_m: number,
  defaultClass: string,
): Promise<ImportOut> {
  return new Promise<ImportOut>((resolve) => {
    const w = new Worker(new URL('../workers/import.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (ev: MessageEvent<ImportOut>) => {
      resolve(ev.data);
      w.terminate();
    };
    const msg: ImportIn = { type: 'process', geojson, tolerance_m, defaultClass };
    w.postMessage(msg);
  });
}
