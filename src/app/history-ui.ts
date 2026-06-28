// History panel rendering & actions (SPEC §10 history panel, §13.4).

import {
  listJourneys,
  deleteJourney,
  clearAll,
  exportHistory,
  importHistory,
} from '../history/journeys';
import type { Journey } from '../core/types';
import { fmtDistance, fmtDuration, fmtSpeed, fmtDate } from './format';

export interface HistoryHandlers {
  onView: (j: Journey) => void;
  onChanged: () => void | Promise<void>;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let wired = false;

export async function renderHistory(handlers: HistoryHandlers): Promise<void> {
  wireOnce(handlers);
  const journeys = await listJourneys();
  const list = $<HTMLUListElement>('history-list');
  list.innerHTML = '';
  if (journeys.length === 0) {
    list.innerHTML = '<li>No journeys yet. Start a ride to record one.</li>';
  }
  for (const j of journeys) {
    list.append(renderItem(j, handlers));
  }
  void updateUsage();
}

function renderItem(j: Journey, handlers: HistoryHandlers): HTMLLIElement {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'jr-head';
  const title = document.createElement('span');
  title.className = 'jr-title';
  title.textContent =
    j.mode === 'routed' ? `${j.startLabel} → ${j.endLabel}` : `Free ride · ${fmtDate(j.createdAt)}`;
  head.append(title);

  const meta = document.createElement('div');
  meta.className = 'jr-meta';
  meta.textContent = `${fmtDate(j.createdAt)} · ${fmtDistance(j.actualDistance_m)} · ${fmtDuration(
    j.elapsedTime_s,
  )} · avg ${fmtSpeed(j.avgMovingSpeed_kmh)} km/h`;

  const actions = document.createElement('div');
  actions.className = 'jr-actions';
  const view = btn('View', () => handlers.onView(j));
  const del = btn('Delete', async () => {
    await deleteJourney(j.id);
    await handlers.onChanged();
    await renderHistory(handlers);
  });
  del.classList.add('danger');
  actions.append(view, del);

  li.append(head, meta, actions);
  return li;
}

function wireOnce(handlers: HistoryHandlers): void {
  if (wired) return;
  wired = true;

  $('history-export').addEventListener('click', async () => {
    const data = await exportHistory();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bikenav-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $<HTMLInputElement>('history-import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    try {
      const count = await importHistory(JSON.parse(await file.text()), true);
      await handlers.onChanged();
      await renderHistory(handlers);
      flash(`Imported ${count} journeys`);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Import failed', true);
    }
  });

  $('history-clear').addEventListener('click', async () => {
    if (!confirm('Delete all saved journeys? This cannot be undone.')) return;
    await clearAll();
    await handlers.onChanged();
    await renderHistory(handlers);
  });
}

async function updateUsage(): Promise<void> {
  const el = $('history-usage');
  if (navigator.storage?.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      if (usage != null) {
        el.textContent = `Storage used: ${(usage / 1024 / 1024).toFixed(1)} MB`;
        return;
      }
    } catch {
      /* ignore */
    }
  }
  el.textContent = '';
}

function btn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'ghost';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function flash(msg: string, error = false): void {
  const el = $('history-usage');
  el.textContent = msg;
  el.style.color = error ? 'var(--danger)' : 'var(--bike)';
  setTimeout(() => {
    el.style.color = '';
    void updateUsage();
  }, 3000);
}
