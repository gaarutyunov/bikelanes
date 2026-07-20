// IndexedDB schema & access (SPEC §13). DB `bikenav`, version 1. Local only.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Journey, SpeedProfile } from '../core/types';

interface BikeNavDB extends DBSchema {
  journeys: {
    key: string;
    value: Journey;
    indexes: { 'by-createdAt': number };
  };
  speedProfile: {
    key: string;
    value: SpeedProfile;
  };
  meta: {
    key: string;
    value: unknown;
  };
}

let dbPromise: Promise<IDBPDatabase<BikeNavDB>> | null = null;

export function db(): Promise<IDBPDatabase<BikeNavDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BikeNavDB>('bikenav', 1, {
      upgrade(d) {
        const j = d.createObjectStore('journeys', { keyPath: 'id' });
        j.createIndex('by-createdAt', 'createdAt');
        d.createObjectStore('speedProfile');
        d.createObjectStore('meta');
      },
    });
  }
  return dbPromise;
}

export const PROFILE_KEY = 'default';
