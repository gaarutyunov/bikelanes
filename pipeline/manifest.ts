// Stage 6 — emit manifest.json with versions, checksums, bbox & attribution
// (SPEC §6 Stage 6, §8). The app reads this first and verifies checksums.

import { ATTRIBUTION, fileBytes, sha256OfData, writeJson } from './util';
import type { Manifest, ArtifactEntry } from '../src/core/types';

export interface ManifestInput {
  bbox: [number, number, number, number];
  basemap: { kind: 'pmtiles' | 'none'; path?: string };
  bikelanes: { kind: 'pmtiles' | 'geojson'; path: string };
  searchRecords: number;
  buildDate: string;
}

const CHECKSUM_ARTIFACTS = [
  ['graph', 'graph.bin'],
  ['coords', 'search/coords.bin'],
  ['searchIndex', 'search/index.json'],
  ['searchMeta', 'search/meta.json'],
  ['bikelanes', 'bikelanes.geojson'],
] as const;

export function writeManifest(input: ManifestInput): void {
  const artifacts: Record<string, ArtifactEntry> = {};
  for (const [name, path] of CHECKSUM_ARTIFACTS) {
    if (fileBytes(path) === 0) continue;
    const { sha256, bytes } = sha256OfData(path);
    artifacts[name] = { path, sha256, bytes };
  }
  if (input.basemap.kind === 'pmtiles' && input.basemap.path && fileBytes(input.basemap.path) > 0) {
    const { sha256, bytes } = sha256OfData(input.basemap.path);
    artifacts.basemap = { path: input.basemap.path, sha256, bytes };
  }

  const manifest: Manifest = {
    schema: 1,
    buildDate: input.buildDate,
    bbox: input.bbox,
    attribution: ATTRIBUTION,
    basemap: input.basemap,
    bikelanes: input.bikelanes,
    artifacts,
    search: { records: input.searchRecords },
  };
  writeJson('manifest.json', manifest);
}
