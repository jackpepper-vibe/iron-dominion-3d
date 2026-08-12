/* Generate home-screen / favicon icon set from IronDominion.png (1024x1024).
 *
 *   node scripts/gen-icons.mjs
 *
 * No native image deps: we rasterise through a headless-Chromium canvas
 * (Playwright is already a dev dependency here). Outputs land in icons/.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'IronDominion.png');
const outDir = resolve(root, 'icons');
mkdirSync(outDir, { recursive: true });

// name, size, background (null = keep source transparency)
const targets = [
  ['icon-192.png', 192, null],
  ['icon-512.png', 512, null],
  ['apple-touch-icon.png', 180, '#23262b'], // iOS ignores alpha; give it a solid bg
  ['favicon-32.png', 32, null],
  ['favicon-16.png', 16, null],
];

const dataUri = 'data:image/png;base64,' + readFileSync(src).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><body>');

for (const [name, size, bg] of targets) {
  const b64 = await page.evaluate(async ({ dataUri, size, bg }) => {
    const img = new Image();
    img.src = dataUri;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size); }
    ctx.drawImage(img, 0, 0, size, size);
    return c.toDataURL('image/png').split(',')[1];
  }, { dataUri, size, bg });
  writeFileSync(resolve(outDir, name), Buffer.from(b64, 'base64'));
  console.log('wrote icons/' + name + '  (' + size + 'x' + size + ')');
}

await browser.close();
