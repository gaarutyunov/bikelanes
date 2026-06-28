// Display formatting helpers.

export function fmtDistance(m: number): string {
  if (!isFinite(m)) return '–';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export function fmtDuration(s: number): string {
  if (!isFinite(s) || s <= 0) return '0:00';
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function fmtSpeed(kmh: number): string {
  if (!isFinite(kmh) || kmh <= 0) return '0.0';
  return kmh.toFixed(1);
}

export function fmtPercent(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

const ETA_SOURCE_LABEL: Record<string, string> = {
  'personal-perclass': 'from your per-surface pace',
  'personal-overall': 'scaled to your pace',
  prior: 'estimated (no history yet)',
};
export function etaSourceLabel(src: string): string {
  return ETA_SOURCE_LABEL[src] ?? src;
}
