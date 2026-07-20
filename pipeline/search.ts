// Stage 4 — build & export the address search index (SPEC §6 Stage 4, §9).

import { createSearchIndex, type AddressRecord } from '../src/core/searchConfig';
import { encodeCoords } from '../src/core/graphFormat';
import { ATTRIBUTION, writeBin, writeJson } from './util';

export interface AddressInput extends AddressRecord {
  lon: number;
  lat: number;
}

export interface SearchOutput {
  records: number;
}

export async function buildAndWriteSearch(addresses: AddressInput[]): Promise<SearchOutput> {
  // Reassign contiguous ids so coords.bin can be indexed directly by id (§9.3).
  const records = addresses.map((a, i) => ({ ...a, id: i }));

  const index = createSearchIndex();
  for (const r of records) {
    index.add({
      id: r.id,
      display: r.display,
      street: r.street,
      number: r.number,
      postcode: r.postcode,
    });
  }

  const parts: Record<string, string> = {};
  await index.export((key, data) => {
    if (data != null) parts[key] = data;
  });
  writeJson('search/index.json', { parts, records: records.length });

  // coords.bin: Float32 [lon,lat] indexed by id.
  const flat: number[] = [];
  for (const r of records) {
    flat[r.id * 2] = r.lon;
    flat[r.id * 2 + 1] = r.lat;
  }
  writeBin('search/coords.bin', encodeCoords(flat));

  writeJson('search/meta.json', {
    records: records.length,
    fields: ['display', 'street', 'number', 'postcode'],
    attribution: ATTRIBUTION,
  });

  return { records: records.length };
}
