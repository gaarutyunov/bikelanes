// Journey CRUD, profile maintenance, retention, and export/import (SPEC §13).

import { db, PROFILE_KEY } from './db';
import { emptyProfile, rebuildProfile, updateProfile } from './profile';
import type { Journey, SpeedProfile } from '../core/types';

export const N_TRACKS = 200; // retain full tracks for the last N journeys (§13.4)

export async function getProfile(): Promise<SpeedProfile> {
  const d = await db();
  return (await d.get('speedProfile', PROFILE_KEY)) ?? emptyProfile(Date.now());
}

export async function saveJourney(j: Journey): Promise<void> {
  const d = await db();
  const profile = (await d.get('speedProfile', PROFILE_KEY)) ?? emptyProfile(Date.now());
  const tx = d.transaction(['journeys', 'speedProfile'], 'readwrite');
  await tx.objectStore('journeys').put(j);
  const updated = updateProfile(profile, j, Date.now());
  await tx.objectStore('speedProfile').put(updated, PROFILE_KEY);
  await tx.done;
  await enforceRetention();
}

export async function listJourneys(): Promise<Journey[]> {
  const d = await db();
  const all = await d.getAllFromIndex('journeys', 'by-createdAt');
  return all.reverse(); // newest first
}

export async function getJourney(id: string): Promise<Journey | undefined> {
  const d = await db();
  return d.get('journeys', id);
}

export async function deleteJourney(id: string): Promise<void> {
  const d = await db();
  await d.delete('journeys', id);
}

export async function clearAll(): Promise<void> {
  const d = await db();
  const tx = d.transaction(['journeys', 'speedProfile'], 'readwrite');
  await tx.objectStore('journeys').clear();
  await tx.objectStore('speedProfile').put(emptyProfile(Date.now()), PROFILE_KEY);
  await tx.done;
}

/** Strip stored tracks from journeys older than the most recent N_TRACKS. */
async function enforceRetention(): Promise<void> {
  const journeys = await listJourneys(); // newest first
  if (journeys.length <= N_TRACKS) return;
  const d = await db();
  const tx = d.transaction('journeys', 'readwrite');
  for (let i = N_TRACKS; i < journeys.length; i++) {
    const j = journeys[i];
    if (j.track.length > 0) {
      j.track = [];
      await tx.store.put(j);
    }
  }
  await tx.done;
}

export interface HistoryExport {
  format: 'bikenav-history';
  version: 1;
  exportedAt: number;
  journeys: Journey[];
  profile: SpeedProfile;
}

export async function exportHistory(): Promise<HistoryExport> {
  return {
    format: 'bikenav-history',
    version: 1,
    exportedAt: Date.now(),
    journeys: await listJourneys(),
    profile: await getProfile(),
  };
}

export async function importHistory(data: unknown, replace = true): Promise<number> {
  const parsed = data as Partial<HistoryExport>;
  if (!parsed || parsed.format !== 'bikenav-history' || !Array.isArray(parsed.journeys)) {
    throw new Error('Not a Bikelanes history export file.');
  }
  const d = await db();
  const tx = d.transaction(['journeys', 'speedProfile'], 'readwrite');
  if (replace) await tx.objectStore('journeys').clear();
  for (const j of parsed.journeys) await tx.objectStore('journeys').put(j);
  await tx.done;

  // Recompute the profile from the merged set so it stays consistent.
  const all = await listJourneys();
  const profile = parsed.profile ?? rebuildProfile(all, Date.now());
  const d2 = await db();
  await d2.put('speedProfile', replace ? profile : rebuildProfile(all, Date.now()), PROFILE_KEY);
  return parsed.journeys.length;
}
