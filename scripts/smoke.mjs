// Headless-Chromium smoke test: serve the built dist/, load the app, and fail
// on console errors, page errors, failed requests, or a map that never renders.
// Run via `npm run smoke` (after `npm run build:app`). Used as a CI gate so
// runtime regressions (e.g. an invalid map style) are caught automatically.

import { preview } from 'vite';
import { chromium } from 'playwright';

const PORT = Number(process.env.SMOKE_PORT ?? 4173);
// In sandboxes a pre-installed browser is referenced via this env var; in CI we
// install the matching browser and let Playwright resolve it (leave it unset).
const EXEC = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

const server = await preview({ preview: { port: PORT, strictPort: true } });
const url = server.resolvedUrls?.local?.[0] ?? `http://localhost:${PORT}/`;
console.log(`· preview server at ${url}`);

let exitCode = 1;
try {
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('#map canvas.maplibregl-canvas', { timeout: 15000 });
  await page
    .waitForFunction(() => /Ready/.test(document.getElementById('status')?.textContent ?? ''), {
      timeout: 20000,
    })
    .catch(() => {
      throw new Error('App never reached "Ready" status');
    });

  const mapSized = await page.evaluate(() => {
    const c = document.querySelector('#map canvas');
    return !!c && c.width > 0 && c.height > 0;
  });
  if (!mapSized) errors.push('map canvas has zero size');

  const status = (await page.locator('#status').textContent().catch(() => '')) ?? '';
  await browser.close();

  if (errors.length) {
    console.error(`\n✗ Smoke test failed (${errors.length} issue(s)):`);
    for (const e of errors) console.error('  - ' + e);
  } else {
    console.log(`\n✓ Smoke test passed — map rendered, status: ${status.trim()}`);
    exitCode = 0;
  }
} catch (err) {
  console.error('\n✗ Smoke test error:', err instanceof Error ? err.message : err);
} finally {
  await server.httpServer?.close?.();
}

process.exit(exitCode);
