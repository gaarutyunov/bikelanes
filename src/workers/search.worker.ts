/// <reference lib="webworker" />
// Search worker: load the prebuilt FlexSearch index + coords store, answer
// debounced autocomplete queries. The index is imported, never rebuilt (§9).

import { createSearchIndex, type AddressRecord, FIELD_PRIORITY } from '../core/searchConfig';
import { decodeCoords, type CoordStore } from '../core/graphFormat';
import { fetchArrayBuffer, fetchJson } from '../core/fetchArtifact';
import type { SearchHit, SearchIn, SearchOut } from './protocol';

interface IndexFile {
  parts: Record<string, string>;
  records: number;
}

let index = createSearchIndex();
let coords: CoordStore | null = null;
let ready = false;

const post = (msg: SearchOut) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = async (ev: MessageEvent<SearchIn>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'load': {
        const [file, coordBuf] = await Promise.all([
          fetchJson<IndexFile>(msg.indexUrl),
          fetchArrayBuffer(msg.coordsUrl),
        ]);
        index = createSearchIndex();
        for (const [key, data] of Object.entries(file.parts)) {
          await index.import(key, data);
        }
        coords = decodeCoords(coordBuf);
        ready = true;
        post({ type: 'ready', records: file.records });
        break;
      }
      case 'query': {
        if (!ready) {
          post({ type: 'results', id: msg.id, hits: [] });
          return;
        }
        post({ type: 'results', id: msg.id, hits: runQuery(msg.text, msg.limit ?? 8) });
        break;
      }
      case 'coord': {
        post({ type: 'coord', id: msg.id, coord: coords?.get(msg.recordId) ?? null });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

function runQuery(text: string, limit: number): SearchHit[] {
  const q = text.trim();
  if (!q) return [];
  const results = index.search(q, { limit, enrich: true });
  // Merge per-field results in priority order, de-duplicating by id.
  const byField = new Map<string, AddressRecord & { id: number }>();
  const order: number[] = [];
  const fieldRank = (f: string) => {
    const i = FIELD_PRIORITY.indexOf(f);
    return i < 0 ? FIELD_PRIORITY.length : i;
  };
  const sorted = results.slice().sort((a, b) => fieldRank(a.field) - fieldRank(b.field));
  for (const fr of sorted) {
    for (const hit of fr.result) {
      if (typeof hit === 'string' || typeof hit === 'number') continue;
      const id = Number(hit.id);
      if (byField.has(String(id))) continue;
      byField.set(String(id), { ...(hit.doc as AddressRecord), id });
      order.push(id);
      if (order.length >= limit) break;
    }
    if (order.length >= limit) break;
  }
  return order.map((id) => {
    const rec = byField.get(String(id))!;
    return {
      id,
      display: rec.display,
      street: rec.street,
      number: rec.number,
      postcode: rec.postcode,
      coord: coords?.get(id) ?? null,
    };
  });
}
