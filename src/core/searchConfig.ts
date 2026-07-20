// Shared FlexSearch configuration (SPEC §9.1). Used by the offline pipeline to
// build & export the index and by search.worker to recreate & import it — the
// encode function is code, so both sides must use this exact module.

import { createDocument, type FlexDocument } from './flexsearch';

export interface AddressRecord {
  id: number;
  display: string;
  street: string;
  number: string;
  postcode: string;
}

// Accent-folding tokenizer for Spanish: lowercase, strip diacritics, ñ→n.
export function foldEncode(str: string): string[] {
  const folded = str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n');
  return folded.split(/[^a-z0-9]+/).filter(Boolean);
}

export function createSearchIndex(): FlexDocument<AddressRecord> {
  return createDocument<AddressRecord>({
    document: {
      id: 'id',
      index: [
        { field: 'street', tokenize: 'forward', encode: foldEncode, resolution: 9 },
        { field: 'display', tokenize: 'forward', encode: foldEncode, resolution: 5 },
        { field: 'number', tokenize: 'forward', encode: foldEncode },
        { field: 'postcode', tokenize: 'forward', encode: foldEncode },
      ],
      store: ['display', 'street', 'number', 'postcode'],
    },
  });
}

// Field search priority for merging multi-field results (street boosted, §9.1).
export const FIELD_PRIORITY = ['street', 'display', 'number', 'postcode'];
