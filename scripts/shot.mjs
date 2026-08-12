/* Headless screenshot harness for Iron Dominion.
 *
 *   node scripts/shot.mjs            -> mission 1, normal fog
 *   node scripts/shot.mjs 2 reveal   -> mission 3, whole map explored
 *
 * The game is a single self-contained index.html, so we load it over file://
 * and drive it by calling the game's own globals (startMission, updateFog,
 * renderRadar) rather than clicking through menus — far more robust.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const mission = Number(process.argv[2] ?? 0);
const reveal = process.argv.includes('reveal');
const outDir = resolve(root, 'shots');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(pathToFileURL(resolve(root, 'index.html')).href);
await page.waitForFunction('typeof startMission === "function"');

// Drop straight into the match: hide the intro overlay and start, mirroring
// the real #startbtn handler (minus the audio beeps, which fail headless).
await page.evaluate(m => {
  document.getElementById('splash').style.display = 'none';
  document.getElementById('intro').style.display = 'none';
  startMission(m);   // also dismisses the splash internally, belt and braces
}, mission);

// Simulate "I've scouted this ground": mark the whole map explored so the
// radar-detection change has territory to work with, then rebuild fog+radar.
if (reveal) {
  await page.evaluate(() => {
    explored.fill(1);
    updateFog();
    renderRadar();
  });
}

// Let the game loop run so terrain is painted and enemy units advance a little.
await page.waitForTimeout(1500);
await page.evaluate(() => renderRadar());

const tag = `m${mission + 1}${reveal ? '-reveal' : ''}`;
await page.locator('#view').screenshot({ path: resolve(outDir, `view-${tag}.png`) });
await page.locator('#radar').screenshot({ path: resolve(outDir, `radar-${tag}.png`) });

// A tight crop of a terrain patch so the mountains/rocks/trees are legible.
await page.locator('#view').screenshot({
  path: resolve(outDir, `terrain-${tag}.png`),
  clip: { x: 0, y: 0, width: 640, height: 420 },
});

await browser.close();
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : `OK -> shots/*-${tag}.png`);
