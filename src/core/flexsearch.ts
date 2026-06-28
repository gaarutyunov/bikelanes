// FlexSearch boundary shim. The published FlexSearch builds expose a single
// default export ({ Document, Index }), but the bundled type definitions declare
// named exports that don't exist at runtime. We import loosely here and re-type
// the surface we use so the rest of the codebase stays fully typed.

// @ts-ignore - default import works at runtime; shipped types disagree.
import FlexSearchModule from 'flexsearch';

export interface FlexFieldOptions {
  field: string;
  tokenize?: 'strict' | 'forward' | 'reverse' | 'full';
  encode?: (s: string) => string[];
  resolution?: number;
}

export interface FlexDocOptions {
  document: { id: string; index: FlexFieldOptions[]; store?: boolean | string[] };
}

export interface FlexEnrichedHit<T> {
  id: string | number;
  doc: T;
}

export interface FlexFieldResult<T> {
  field: string;
  result: Array<FlexEnrichedHit<T> | string | number>;
}

export interface FlexDocument<T> {
  add(doc: T): FlexDocument<T>;
  search(query: string, options?: { limit?: number; enrich?: boolean }): Array<FlexFieldResult<T>>;
  export(handler: (key: string, data: string) => void | Promise<void>): Promise<void>;
  import(key: string, data: string): Promise<void>;
}

interface FlexApi {
  Document: new <T>(opts: FlexDocOptions) => FlexDocument<T>;
}

const FlexSearch = FlexSearchModule as unknown as FlexApi;

export function createDocument<T>(opts: FlexDocOptions): FlexDocument<T> {
  return new FlexSearch.Document<T>(opts);
}
