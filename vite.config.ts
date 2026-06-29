import { defineConfig, type Plugin } from 'vite';
import { cpSync, existsSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';

// The /data artifacts live at the repo root (not /public) per the spec layout
// (SPEC §8, §16). On build, copy them into dist/data so the published site can
// fetch them with relative URLs (§17.4). On dev, serve them from the root.
function dataPlugin(): Plugin {
  const root = resolve(__dirname, 'data');
  return {
    name: 'bikenav-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith('/data/')) return next();
        const file = resolve(__dirname, '.' + path);
        if (!file.startsWith(root) || !existsSync(file)) return next();
        const type = file.endsWith('.json')
          ? 'application/json'
          : file.endsWith('.geojson')
            ? 'application/geo+json'
            : 'application/octet-stream';
        res.setHeader('Content-Type', type);
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const dest = resolve(__dirname, 'dist/data');
      if (existsSync(root)) {
        cpSync(root, dest, { recursive: true });
        this.warn?.(`copied data/ → dist/data`);
      } else {
        this.warn?.('data/ not found — run `npm run build:sample-data` or `npm run build:data`');
      }
    },
  };
}

// base: './' (relative) is REQUIRED so the same dist/ bundle works at the
// production Pages path and at every PR-preview subpath (SPEC §17.4).
export default defineConfig({
  base: './',
  plugins: [dataPlugin()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  // Workers are emitted as ES modules so imports inside them work.
  worker: {
    format: 'es',
  },
});
