import { defineConfig, type Plugin } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Copy the committed /data artifacts into dist/data so the published site can
// fetch them with relative URLs (SPEC §8, §16, §17.4). They live at the repo
// root (not /public) per the spec directory layout.
function copyData(): Plugin {
  return {
    name: 'copy-data',
    apply: 'build',
    closeBundle() {
      const src = resolve(__dirname, 'data');
      const dest = resolve(__dirname, 'dist/data');
      if (existsSync(src)) {
        cpSync(src, dest, { recursive: true });
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
  plugins: [copyData()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  // Workers are emitted as ES modules so imports inside them work.
  worker: {
    format: 'es',
  },
});
