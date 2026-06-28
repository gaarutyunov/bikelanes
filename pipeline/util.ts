// Shared helpers for the offline build pipeline (Node).

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
export const DATA_DIR = join(ROOT, 'data');
export const RAW_DIR = join(ROOT, 'pipeline', 'raw');

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeBin(relPath: string, buf: ArrayBuffer | Uint8Array): void {
  const full = join(DATA_DIR, relPath);
  ensureDir(dirname(full));
  writeFileSync(full, Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
}

export function writeJson(relPath: string, obj: unknown): void {
  const full = join(DATA_DIR, relPath);
  ensureDir(dirname(full));
  writeFileSync(full, JSON.stringify(obj));
}

export function writeText(relPath: string, text: string): void {
  const full = join(DATA_DIR, relPath);
  ensureDir(dirname(full));
  writeFileSync(full, text);
}

export function sha256OfData(relPath: string): { sha256: string; bytes: number } {
  const full = join(DATA_DIR, relPath);
  const data = readFileSync(full);
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

export function rawExists(name: string): boolean {
  return existsSync(join(RAW_DIR, name));
}

export function readRawJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(RAW_DIR, name), 'utf8')) as T;
}

export function fileBytes(relPath: string): number {
  const full = join(DATA_DIR, relPath);
  return existsSync(full) ? statSync(full).size : 0;
}

export const ATTRIBUTION = [
  '© OpenStreetMap contributors',
  '© Ayuntamiento de Málaga — datos abiertos (CC BY 4.0)',
];
