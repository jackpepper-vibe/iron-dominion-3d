/* Posed real-GPU captures for judging the look of Iron Dominion 3D.
 *
 *   node scripts/look.mjs [--tag before] [--only base,battle] [--perf]
 *
 * --perf also times 120 renders per pose (GPU-synchronised with a 1-pixel
 * readPixels, vsync and the frame cap off) and prints the median in ms.
 * Writes shots/look/<tag>-<pose>.png. Unlike scripts/shot.mjs and the shared
 * screenshot tool, this launches Chromium on the real GPU (ANGLE/D3D11), so the
 * frames are what a player sees rather than SwiftShader's approximation —
 * shadows, anisotropy and MSAA included. Every pose is deterministic: fixed
 * mission seed, fixed camera, and the simulation stepped a fixed number of
 * ticks, so a before/after pair differs only by the change being judged.
 *
 * This is for looking at. It asserts nothing; scripts/smoke.mjs does that.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const tag = arg('tag', 'look');
const only = arg('only', '').split(',').filter(Boolean);
const perf = process.argv.includes('--perf');
const outDir = resolve(root, 'shots/look');
mkdirSync(outDir, { recursive: true });

/* Each pose: a mission, then a setup run inside the page, then a capture.
   `setup` runs with ID3 in scope and returns nothing; `steps` advances the
   simulation deterministically before the frame is taken. */
const POSES = [
  { name: 'base', mission: 0, setup: () => { ID3.find('conyard', 520); } },
  { name: 'showcase', mission: 0, steps: 2, setup: () => {
      /* Every structure and vehicle side by side on open ground near home, so
         the model kit is judged as a set rather than one at a time. */
      const S = ID3.sim, y0 = S.MAPH - 30;
      const row = ['power', 'refinery', 'barracks', 'factory', 'turret', 'guardtower', 'bastion', 'helipad', 'techlab'];
      let x = 4;
      for (const t of row) { const b = ID3.build(0, t, x, y0); x += b.w + 1; }
      const units = ['trooper', 'rocketeer', 'grenadier', 'buggy', 'tank', 'heavy', 'artillery', 'harvester', 'gunship'];
      units.forEach((t, i) => { const u = ID3.spawn(0, t, 5 + i * 2.2, y0 + 5); u.angle = -0.5; });
      ID3.look(15, y0 + 3, 640);
    } },
  { name: 'ore', mission: 2, steps: 90, setup: () => {
      const S = ID3.sim, h = S.units.find(u => u.type === 'harvester' && u.owner === 0);
      ID3.step(400, 1 / 30);   // let it drive out to a seam
      ID3.cam(h.x, h.y + 60, 460);
    } },
  { name: 'battle', mission: 0, steps: 0, setup: () => {
      const S = ID3.sim, y0 = S.MAPH - 24;
      for (let i = 0; i < 5; i++) ID3.spawn(0, i < 2 ? 'heavy' : 'tank', 10 + i * 1.5, y0 + 4);
      for (let i = 0; i < 5; i++) ID3.spawn(1, i < 2 ? 'heavy' : 'tank', 10 + i * 1.5, y0 - 3);
      for (let i = 0; i < 4; i++) ID3.spawn(1, 'trooper', 16 + i, y0 - 2);
      ID3.step(75, 1 / 30);
      ID3.look(13, y0 + 1, 520);
    } },
  { name: 'enemy', mission: 4, steps: 30, setup: () => {
      const S = ID3.sim, c = S.buildings.find(b => b.owner === 1 && b.type === 'conyard');
      ID3.cam(c.x, c.y + 90, 760);
    } },
  { name: 'overview', mission: 1, steps: 30, setup: () => { ID3.cam(1150, 1250, 1500); } },
];

const server = await startServer({ root });
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
  ...(perf ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(`${server.origin}/index.html`);
await page.waitForFunction('typeof ID3 === "object"');
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log('renderer:', gpu);

for (const pose of POSES) {
  if (only.length && !only.includes(pose.name)) continue;
  await page.evaluate(mission => {
    document.getElementById('splash').style.display = 'none';
    document.getElementById('intro').style.display = 'none';
    ID3.mission(mission, true);
    ID3.sim.selection = [];
  }, pose.mission);
  await page.evaluate(`(${pose.setup})()`);
  if (pose.steps) await page.evaluate(n => ID3.step(n, 1 / 30), pose.steps);
  /* Pause so the live loop cannot move anything between setup and capture,
     then give the renderer a few frames to settle shadows and uploads. */
  await page.keyboard.press('p');
  await page.evaluate(() => { document.getElementById('pausebanner').style.display = 'none'; });
  await page.waitForTimeout(700);
  const file = resolve(outDir, `${tag}-${pose.name}.png`);
  await page.locator('#view').screenshot({ path: file });
  let timing = '';
  if (perf) {
    const ms = await page.evaluate(() => {
      const gl = document.getElementById('view').getContext('webgl2'), px = new Uint8Array(4), t = [];
      for (let i = 0; i < 140; i++) {
        const t0 = performance.now();
        ID3.R3D.render(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (i >= 20) t.push(performance.now() - t0);
      }
      t.sort((a, b) => a - b);
      return t[t.length >> 1];
    });
    timing = `  ${ms.toFixed(1)} ms/frame`;
  }
  await page.keyboard.press('p');
  console.log('  ', file + timing);
}

await browser.close();
await server.close();
if (errors.length) { console.log('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
