# BikeNav Málaga

A browser-only, client-side bike-lane navigation web app for Málaga, hosted on
GitHub Pages. All map, routing and search data is **prebuilt offline** and
shipped as static artifacts — there are **no runtime network or API
dependencies**. See [`SPEC.md`](./SPEC.md) for the full technical specification.

## Features

- **Fastest cycling routes** over Málaga's bike-lane + road network (NBA\* in a
  worker, `ngraph.path`).
- **Preference slider** (“prefer bike lanes” ↔ “fastest”) that re-routes live
  via a per-class comfort penalty — without rebuilding the graph.
- **Hard exclusion** of motorways and any `bicycle=no` / `access=no` segment,
  enforced at build time and as a routing guard.
- **Offline address search** (prebuilt, exported FlexSearch index + packed
  coord store) with Spanish accent folding.
- **Import your own GeoJSON** lines and route over them (or merge with Málaga).
- **Live navigation**: speed/progress HUD, off-route reroute, Screen Wake Lock.
- **Local journey history** (IndexedDB, never uploaded) with export/import.
- **Personalized ETA** computed from the rider's own recorded average speed,
  falling back to per-class priors until enough history exists.

## Getting started

```bash
npm install
npm run build:sample-data   # generate the committed /data/* sample artifacts
npm run dev                 # http://localhost:5173
```

`npm run build:app` type-checks and bundles the site into `dist/` (and copies
`/data` into `dist/data`). `npm run build` is an alias.

## Data pipeline

The routing graph, search index and display layers are produced by an offline,
re-runnable pipeline (`/pipeline`) and committed under `/data` as regular Git
files (never Git LFS — GitHub Pages does not serve LFS objects).

- `npm run build:sample-data` — generate a small synthetic central-Málaga
  dataset so the app runs without the full toolchain. **This is the committed
  default.**
- `npm run build:data` — the real build. Run `tsx pipeline/fetch.ts` first to
  download municipal + OSM sources into `pipeline/raw/` (build-time only; needs
  network, and GDAL/tippecanoe/Planetiler for reprojection and tiles).

Artifacts (`SPEC.md` §8):

| Path                     | Purpose                          |
| ------------------------ | -------------------------------- |
| `data/manifest.json`     | versions, checksums, bbox, attr. |
| `data/graph.bin`         | prebuilt routing graph (§7.1)    |
| `data/search/index.json` | exported FlexSearch index        |
| `data/search/coords.bin` | id → lon/lat (Float32, §9.3)     |
| `data/search/meta.json`  | record count, schema, attr.      |
| `data/bikelanes.geojson` | cycle-infra display layer        |
| `data/basemap.pmtiles`   | vector basemap (real build only) |

## Deployment

GitHub Pages in **branch mode** (`gh-pages`), driven by GitHub Actions:

- `.github/workflows/deploy.yml` — builds the app and publishes `dist/` to the
  `gh-pages` root on push to `main`.
- `.github/workflows/preview.yml` — per-PR preview deploys with automatic
  cleanup on close.

Vite `base: './'` keeps all asset/data URLs relative so the same bundle works at
the production path and at every preview subpath. See `SPEC.md` §17.

## Architecture

```
src/core/     isomorphic: classes, graph format, preference, ETA, search config
src/workers/  search · routing · import workers (+ shared dataset/protocol)
src/nav/      journey session controller, live speed/progress
src/history/  IndexedDB stores, speed profile, export/import
src/app/      map, worker clients, UI orchestration
pipeline/     offline build (fetch, graph, search, tiles, manifest, sample)
```

## Attribution

© OpenStreetMap contributors (ODbL) · © Ayuntamiento de Málaga — datos abiertos
(CC BY 4.0) · MapLibre / Protomaps as applicable.
