# Bikelanes

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
npm run fetch:data          # download municipal + OSM sources into pipeline/raw
npm run build:data          # build /data/* artifacts from them (needs network)
npm run dev                 # http://localhost:5173
```

`/data` is **not committed** — it's generated. In CI it's built on every deploy;
for local dev run `fetch:data` + `build:data` once (both need outbound network
for the Málaga portal + Overpass). `npm run build:app` type-checks and bundles
the site into `dist/` (and copies `/data` into `dist/data`). `npm run build` is
an alias.

## Data pipeline

The routing graph, search index and display layers are produced by an offline,
re-runnable pipeline (`/pipeline`). They are **built by CI and published into
`dist/`, never committed and never hand-authored** — there is no synthetic
sample dataset.

- `npm run fetch:data` — download sources into `pipeline/raw/` (cached; skips
  files already present). **Primary source is OpenStreetMap via Overpass** — one
  reliable, programmatic API with Málaga's cycleways, roads *and* addresses. The
  municipal `carril-bici` layer is fetched as a best-effort authoritative
  augmentation; if the portal URL is unavailable the build proceeds with OSM
  cycleways alone (not a runtime fallback — see SPEC §3).
- `npm run build:data` — build `/data/*` from the raw sources. Spatial-index
  noding/snapping keeps this fast even at city scale. Optional
  GDAL/tippecanoe/Planetiler enable reprojection and PMTiles; without them the
  pipeline ships the `bikelanes.geojson` display layer.

### Real data is built by CI, not by hand

Both `deploy.yml` and `preview.yml` run `fetch:data` + `build:data` before
`build:app` on **GitHub's runners** (which have the network access a local
sandbox may not). Raw sources are cached weekly, so most runs skip the
downloads. This is why the data sources my development sandbox couldn't reach
get resolved automatically in CI.

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

### Smoke test (CI gate)

`npm run smoke` builds nothing itself but loads the already-built `dist/` in
headless Chromium (via Playwright), failing on console errors, failed requests,
or a map that never renders. `ci.yml` runs it on every push/PR, and `deploy.yml`
runs it before publishing, so a broken build (e.g. an invalid map style) can't
reach production. Locally: `npm run build:app && npm run smoke`.

### Routing check (CI gate)

`npm run check:routing` runs the production router over the freshly built
`data/graph.bin` for a fixed set of Málaga corridors and fails if the routes stop
following the bike network — the app's whole point, and something a
route-that-merely-exists doesn't prove. Both `ci.yml` and `deploy.yml` run it
after `build:data`. Locally: `npm run build:data && npm run check:routing`.

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
