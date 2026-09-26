/* Headless screenshot harness for Iron Dominion.
 *
 *   node scripts/shot.mjs            -> mission 1, normal fog
 *   node scripts/shot.mjs 2 reveal   -> mission 3, whole map explored
 *
 * The game is an ES module, which browsers will not load over file://, so the
 * page is served from a throwaway local server. It is driven through the
 * game's window.ID3 test hook rather than by clicking through menus — far more
 * robust.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const mission = Number(process.argv[2] ?? 0);
const reveal = process.argv.includes('reveal');
const outDir = resolve(root, 'shots');
mkdirSync(outDir, { recursive: true });

const server = await startServer({ root });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`${server.origin}/index.html`);
await page.waitForFunction('typeof ID3 === "object"');

// Drop straight into the match: hide the intro overlay and start, mirroring
// the real #startbtn handler (minus the audio beeps, which fail headless).
// With `reveal`, the whole map is marked explored ("I've scouted this
// ground") and fog and radar are rebuilt from it.
await page.evaluate(([m, r]) => {
  document.getElementById('splash').style.display = 'none';
  document.getElementById('intro').style.display = 'none';
  ID3.mission(m, r);   // startMission also dismisses the splash, belt and braces
}, [mission, reveal]);

// Let the game loop run so terrain is painted and enemy units advance a little.
await page.waitForTimeout(1500);
await page.evaluate(() => ID3.sim.renderRadar());

const tag = `m${mission + 1}${reveal ? '-reveal' : ''}`;
await page.locator('#view').screenshot({ path: resolve(outDir, `view-${tag}.png`) });
await page.locator('#radar').screenshot({ path: resolve(outDir, `radar-${tag}.png`) });

// A tight crop of a terrain patch so the mountains/rocks/trees are legible.
await page.locator('#view').screenshot({
  path: resolve(outDir, `terrain-${tag}.png`),
  clip: { x: 0, y: 0, width: 640, height: 420 },
});

await browser.close();
await server.close();
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : `OK -> shots/*-${tag}.png`);
