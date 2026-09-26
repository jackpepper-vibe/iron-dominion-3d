/* Headless smoke test for Iron Dominion 3D.
 *
 *   node scripts/smoke.mjs
 *
 * The 3D fork rewrote every path between the pointer and the simulation:
 * screen-to-world is a raycast against the heightfield, entity picking goes
 * through the models, and marquee selection is a screen rectangle. None of that
 * is exercised by a screenshot, so it gets its own test.
 *
 * Fails on any page error, any WebGL/shader warning, or any assertion below.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

/* The game is an ES module: it is served (file:// will not load modules), and
 * its state is reached through the ID3.sim facade rather than as globals. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await startServer({ root });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e));
page.on('console', m => {
  const t = m.text();
  // Context loss on teardown and driver perf notes are the harness, not the game.
  if (/CONTEXT_LOST|Context (Lost|Restored)|GL Driver Message/i.test(t)) return;
  if (m.type() === 'error' || /THREE\.\w+: |shader|GLSL/i.test(t)) errors.push(`console.${m.type()}: ${t}`);
});

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? ' ok ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

await page.goto(`${server.origin}/index.html`);
await page.waitForFunction('typeof ID3 === "object"');
await page.evaluate(() => {
  document.getElementById('splash').style.display = 'none';
  document.getElementById('intro').style.display = 'none';
  ID3.mission(0, true);
});
await page.waitForTimeout(900);

/* ---- the heightfield actually has relief, and the sim agrees with it ---- */
const relief = await page.evaluate(() => {
  const { MAPW, MAPH, TILE } = ID3.sim;
  let mn = 1e9, mx = -1e9;
  for (let ty = 0; ty < MAPH; ty += 2) for (let tx = 0; tx < MAPW; tx += 2) {
    const h = ID3.R3D.groundH(tx * TILE + 16, ty * TILE + 16);
    mn = Math.min(mn, h); mx = Math.max(mx, h);
  }
  return { mn, mx };
});
check('terrain has real relief', relief.mx - relief.mn > 60,
  `${relief.mn.toFixed(0)}..${relief.mx.toFixed(0)} units`);

/* ---- screen <-> world round-trips through the raycast ---- */
const round = await page.evaluate(() => {
  const g = ID3.R3D.screenToGround(640, 400);
  if (!g) return null;
  const p = ID3.R3D.project(g.x, ID3.R3D.groundH(g.x, g.y), g.y);
  return { g, err: Math.hypot(p.x - 640, p.y - 400) };
});
check('screen->ground->screen round-trips', round && round.err < 3,
  round ? `${round.err.toFixed(2)} px error` : 'no ground hit');

/* ---- clicking a unit selects it (raycast against the model) ---- */
const sel = await page.evaluate(async () => {
  const S = ID3.sim, view = document.getElementById('view');
  const u = S.units.find(x => x.owner === S.PLAYER && x.type !== 'harvester') || S.units[0];
  ID3.cam(u.x, u.y, 500);
  ID3.R3D.render(0);
  const p = ID3.R3D.project(u.x, ID3.R3D.groundH(u.x, u.y) + 8, u.y);
  const fire = (t, b) => view.dispatchEvent(new MouseEvent(t, {
    bubbles: true, button: b, clientX: p.x, clientY: p.y }));
  fire('mousedown', 0);
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: p.x, clientY: p.y }));
  return { picked: S.selection.length, wanted: u.type, got: S.selection[0] && S.selection[0].type };
});
check('click selects the unit under the cursor', sel.picked === 1 && sel.got === sel.wanted,
  `${sel.picked} selected (${sel.got})`);

/* ---- right-click issues a move order to the ground that was clicked ---- */
const order = await page.evaluate(() => {
  const S = ID3.sim, view = document.getElementById('view');
  const u = S.selection[0];
  const tgt = { x: u.x + 130, y: u.y - 90 };
  const p = ID3.R3D.project(tgt.x, ID3.R3D.groundH(tgt.x, tgt.y), tgt.y);
  view.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: p.x, clientY: p.y }));
  return u.dest ? { d: Math.hypot(u.dest[0] - tgt.x, u.dest[1] - tgt.y), order: u.order } : null;
});
check('right-click orders a move to that ground', order && order.d < 60,
  order ? `${order.d.toFixed(0)} units from the click, order=${order.order}` : 'no destination set');

/* ---- marquee selection is a screen rectangle ---- */
const marquee = await page.evaluate(() => {
  const S = ID3.sim, view = document.getElementById('view');
  S.selection = [];
  const mine = S.units.filter(u => u.owner === S.PLAYER);
  const c = mine[0];
  ID3.cam(c.x, c.y, 900);
  ID3.R3D.render(0);
  const fire = (el, t, b, x, y) => el.dispatchEvent(new MouseEvent(t, {
    bubbles: true, button: b, clientX: x, clientY: y }));
  fire(view, 'mousedown', 0, 5, 5);
  fire(view, 'mousemove', 0, 1275, 795);
  fire(window, 'mouseup', 0, 1275, 795);
  const onScreen = mine.filter(u => {
    const p = ID3.R3D.project(u.x, ID3.R3D.groundH(u.x, u.y) + 8, u.y);
    return p.z < 1 && p.x >= 0 && p.x <= 1280 && p.y >= 0 && p.y <= 800;
  }).length;
  return { sel: S.selection.length, onScreen };
});
check('marquee selects what is visibly inside it', marquee.sel > 0 && marquee.sel <= marquee.onScreen,
  `${marquee.sel} of ${marquee.onScreen} on screen`);

/* ---- placement: ghost follows the ground, and the click lands the building ---- */
const place = await page.evaluate(() => {
  const S = ID3.sim, view = document.getElementById('view'), { TILE } = S;
  const yard = S.buildings.find(b => b.owner === S.PLAYER && b.type === 'conyard');
  ID3.cam(yard.x, yard.y, 480);
  ID3.R3D.render(0);
  S.placing = 'power';
  const before = S.buildings.length;
  /* Find ground the game itself considers legal rather than assuming a tile is
     free — the starting units are parked right around the yard. */
  let spot = null;
  for (let r = 3; r <= 6 && !spot; r++)
    for (let dy = -r; dy <= r && !spot; dy++)
      for (let dx = -r; dx <= r && !spot; dx++) {
        const tx = yard.tx + dx, ty = yard.ty + dy;
        if (S.canPlace('power', tx, ty, S.PLAYER)) spot = { tx, ty };
      }
  if (!spot) return { added: 0, last: null, placingCleared: false, spot: null };
  const { tx, ty } = spot;
  const wx = (tx + 1) * TILE, wy = (ty + 1) * TILE;
  const p = ID3.R3D.project(wx, ID3.R3D.groundH(wx, wy), wy);
  view.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: p.x, clientY: p.y }));
  const added = S.buildings.length - before;
  return { added, placingCleared: S.placing === null, spot,
           last: added ? S.buildings[S.buildings.length - 1].type : null };
});
check('placement click builds the structure', place.added === 1 && place.last === 'power' && place.placingCleared,
  `added ${place.added} (${place.last}) at ${place.spot ? place.spot.tx + ',' + place.spot.ty : 'nowhere legal'}`);

/* ---- fog of war reaches the scatter, not just the ground ---- */
const shroud = await page.evaluate(() => {
  const mats = [];
  ID3.R3D.scene.traverse(o => { if (o.isInstancedMesh) mats.push(o.material); });
  return { instanced: mats.length, patched: mats.filter(m => typeof m.onBeforeCompile === 'function').length };
});
check('instanced scatter is shrouded like the ground',
  shroud.instanced > 0 && shroud.patched === shroud.instanced,
  `${shroud.patched}/${shroud.instanced} materials patched`);

/* ---- a burst of combat does not leak views or throw ---- */
const churn = await page.evaluate(() => {
  const S = ID3.sim;
  const before = { b: S.buildings.length, u: S.units.length };
  for (let i = 0; i < 12; i++) ID3.spawn(1, 'tank', 20 + i, 30);
  ID3.step(120, 1 / 30);
  S.units.filter(u => u.owner === S.ENEMY).slice(0, 8).forEach(u => { u.hp = 0; S.killEntity(u); });
  ID3.step(60, 1 / 30);
  ID3.R3D.render(0.033);
  let views = 0;
  ID3.R3D.scene.traverse(o => { if (o.userData && o.userData.eid !== undefined) views++; });
  return { before, after: { b: S.buildings.length, u: S.units.length }, views };
});
check('entity views track the sim through churn',
  churn.views <= churn.after.b + churn.after.u,
  `${churn.views} views for ${churn.after.b}+${churn.after.u} entities`);

/* ---- save / restore survives the new camera semantics ---- */
const save = await page.evaluate(() => {
  const S = ID3.sim;
  S.camX = 900; S.camY = 1200;
  S.saveGame('test');
  S.camX = 0; S.camY = 0;
  const okLoad = S.loadGame();
  return { okLoad, camX: S.camX, camY: S.camY };
});
check('save and restore round-trips the camera', save.okLoad !== false && Math.abs(save.camX - 900) < 1,
  `camX=${save.camX}, camY=${save.camY}`);

await page.waitForTimeout(400);
await browser.close();
await server.close();

const failed = checks.filter(c => !c.pass);
if (errors.length) { console.log('\nPAGE ERRORS:\n' + errors.join('\n')); }
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length || errors.length ? 1 : 0);
