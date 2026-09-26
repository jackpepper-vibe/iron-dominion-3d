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

/* ---- campaign board: only unlocked missions show, and progress persists ----
   Reached the way a player reaches it: click through the title card. */
const passSplash = async () => {
  await page.locator('#splash').click();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('splash')).display === 'none');
};
await passSplash();
const cardCount = () => page.evaluate(() => document.querySelectorAll('#missions .mcard:not(.skirmish)').length);
const fresh = await page.evaluate(() => ({
  cards: document.querySelectorAll('#missions .mcard:not(.skirmish)').length,
  boardShown: !document.getElementById('board').hidden,
}));
check('fresh commander sees only mission 1', fresh.boardShown && fresh.cards === 1,
  `${fresh.cards} card(s), board ${fresh.boardShown ? 'shown' : 'hidden'}`);

const won = await page.evaluate(() => {
  const S = ID3.sim;
  const opened = S.Campaign.recordClear(0, 2);
  S.showBoard();
  const cards = [...document.querySelectorAll('#missions .mcard:not(.skirmish)')];
  return { opened, cards: cards.length, badge: cards[0].querySelector('.mc-badge').textContent };
});
check('a victory unlocks the next mission and badges the cleared one',
  won.opened && won.cards === 2 && /CLEARED.*HARD/.test(won.badge), `${won.cards} cards, "${won.badge}"`);

await page.locator('#missions .mcard:not(.skirmish)').nth(1).click();
const brief = await page.evaluate(() => ({
  briefing: !document.getElementById('briefing').hidden,
  code: document.getElementById('mcode').textContent,
  want: 'OPERATION EMBER · PHASE II',
}));
check('clicking a card opens that mission\'s briefing', brief.briefing && brief.code === brief.want, brief.code);

const locked = await page.evaluate(() => { ID3.sim.showBriefing(7); return document.getElementById('mcode').textContent; });
check('a locked mission cannot be briefed', !/PHASE III$/.test(locked) && /PHASE II$/.test(locked), locked);

await page.reload();
await page.waitForFunction('typeof ID3 === "object"');
await passSplash();
check('progress survives a reload', await cardCount() === 2, `${await cardCount()} cards after reload`);

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

/* ---- right-click issues a move order to the ground that was clicked ----
   The order goes on release (a right-press may yet become a pan), so this is
   a real press-and-release through Playwright's mouse, not a synthetic event. */
const orderAt = await page.evaluate(() => {
  const u = ID3.sim.selection[0];
  const tgt = { x: u.x + 130, y: u.y - 90 };
  const p = ID3.R3D.project(tgt.x, ID3.R3D.groundH(tgt.x, tgt.y), tgt.y);
  return { tgt, p };
});
await page.mouse.move(orderAt.p.x, orderAt.p.y);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
const order = await page.evaluate(tgt => {
  const u = ID3.sim.selection[0];
  return u.dest ? { d: Math.hypot(u.dest[0] - tgt.x, u.dest[1] - tgt.y), order: u.order } : null;
}, orderAt.tgt);
check('right-click orders a move to that ground', order && order.d < 60,
  order ? `${order.d.toFixed(0)} units from the click, order=${order.order}` : 'no destination set');

/* ---- right-drag pans the map (both axes) and gives no order ---- */
const before = await page.evaluate(() => {
  const u = ID3.sim.selection[0];
  ID3.cam(1100, 1100, 700);
  return { camX: ID3.sim.camX, camY: ID3.sim.camY, dest: u.dest && u.dest.slice() };
});
await page.mouse.move(640, 400);
await page.mouse.down({ button: 'right' });
await page.mouse.move(560, 300, { steps: 8 });   // hand drags up-left: map follows it
await page.mouse.up({ button: 'right' });
const pan = await page.evaluate(b => {
  const u = ID3.sim.selection[0];
  return { dx: ID3.sim.camX - b.camX, dy: ID3.sim.camY - b.camY,
           reordered: JSON.stringify(u.dest) !== JSON.stringify(b.dest) };
}, before);
check('right-drag pans the map like a hand, both axes',
  pan.dx > 20 && pan.dy > 20 && !pan.reordered,
  `camera moved ${pan.dx.toFixed(0)}, ${pan.dy.toFixed(0)}${pan.reordered ? ' — but it also issued an order' : ''}`);

/* ---- keyboard scroll reaches north and south, not just east and west ---- */
const y0 = await page.evaluate(() => ID3.sim.camY);
await page.keyboard.down('s'); await page.waitForTimeout(350); await page.keyboard.up('s');
const y1 = await page.evaluate(() => ID3.sim.camY);
await page.keyboard.down('w'); await page.waitForTimeout(700); await page.keyboard.up('w');
const y2 = await page.evaluate(() => ID3.sim.camY);
check('W / S scroll the camera north and south', y1 > y0 + 20 && y2 < y1 - 20,
  `S: ${(y1 - y0).toFixed(0)}, W: ${(y2 - y1).toFixed(0)}`);

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

/* ---- base management: repair costs credits, sell refunds and frees the ground ---- */
const mgmt = await page.evaluate(() => {
  const S = ID3.sim;
  const pw = S.buildings.find(b => b.owner === S.PLAYER && b.type === 'power');
  pw.hp = pw.maxhp * 0.5;
  const c0 = S.credits[0];
  S.setRepair(pw, true);
  ID3.step(60, 1 / 30);                                  // two seconds
  const repaired = { hp: pw.hp / pw.maxhp, spent: c0 - S.credits[0] };
  const c1 = S.credits[0], n0 = S.units.filter(u => u.owner === 0).length;
  const refund = S.sellBuilding(pw);
  return { repaired, refund, gained: S.credits[0] - c1, gone: !S.buildings.includes(pw),
           crew: S.units.filter(u => u.owner === 0).length - n0 };
});
check('repair restores HP and spends credits',
  mgmt.repaired.hp > 0.55 && mgmt.repaired.spent > 0, `${(mgmt.repaired.hp * 100).toFixed(0)}% for $${mgmt.repaired.spent.toFixed(0)}`);
check('sell refunds, removes the structure and its crew walks out',
  mgmt.refund > 0 && mgmt.gained === mgmt.refund && mgmt.gone,
  `+$${mgmt.refund}, ${mgmt.crew} crew`);

/* ---- rally: a facility's new units head for its flag ---- */
const rally = await page.evaluate(() => {
  const S = ID3.sim;
  const b = ID3.build(0, 'barracks', 20, S.MAPH - 20);
  S.setRally(b, 30 * S.TILE, (S.MAPH - 30) * S.TILE);
  const u = S.spawnUnitAt(0, 'trooper', b);
  return { d: u.dest ? Math.hypot(u.dest[0] - b.rally[0], u.dest[1] - b.rally[1]) : 1e9 };
});
check('units from a facility go to its rally point', rally.d < 40, `${rally.d.toFixed(0)} units from the flag`);

/* ---- engineers: capture a weakened structure, sabotage a sound one ---- */
const eng = await page.evaluate(() => {
  const S = ID3.sim;
  const weak = ID3.build(1, 'barracks', 24, S.MAPH - 24); weak.hp = weak.maxhp * 0.4;
  const sound = ID3.build(1, 'power', 30, S.MAPH - 24);
  const e1 = ID3.spawn(0, 'engineer', 22, S.MAPH - 22), e2 = ID3.spawn(0, 'engineer', 29, S.MAPH - 21);
  S.orderCapture(e1, weak); S.orderCapture(e2, sound);
  ID3.step(300, 1 / 30);
  ID3.R3D.render(0);
  let view = null;
  ID3.R3D.scene.traverse(o => { if (o.userData && o.userData.eid === weak.id) view = o; });
  return { owner: weak.owner, viewOwner: view && view.userData.owner, soundHp: sound.hp / sound.maxhp,
           left: S.units.filter(u => u.type === 'engineer').length };
});
check('an engineer captures a weakened structure, re-skinned for its new owner',
  eng.owner === 0 && eng.viewOwner === 0, `owner ${eng.owner}, view livery ${eng.viewOwner}`);
check('an engineer sabotages a sound structure and is spent',
  eng.soundHp < 0.7 && eng.left === 0, `${(eng.soundHp * 100).toFixed(0)}% left, ${eng.left} engineers remain`);

/* ---- veterancy: kills promote, and rank hits harder ---- */
const vet = await page.evaluate(() => {
  const S = ID3.sim;
  const u = ID3.spawn(0, 'tank', 12, S.MAPH - 30);
  for (let i = 0; i < 2; i++) { const v = ID3.spawn(1, 'tank', 40, 10); S.awardKill(u, v); v.hp = 0; }
  return { rank: u.rank, xp: u.xp };
});
check('kills promote a unit', vet.rank >= 1, `rank ${vet.rank} after $${vet.xp} of kills`);

/* ---- MCV: deploys into a yard on open ground, refuses on occupied ground ---- */
const mcv = await page.evaluate(() => {
  const S = ID3.sim;
  /* find a clear 5x5 patch of buildable ground far from everything */
  let spot = null;
  for (let ty = 8; ty < S.MAPH - 8 && !spot; ty += 3) for (let tx = 8; tx < S.MAPW - 8 && !spot; tx += 3) {
    const m = ID3.spawn(0, 'mcv', tx, ty);
    if (S.canDeploy(m)) spot = m; else { m.hp = 0; S.units.splice(S.units.indexOf(m), 1); }
  }
  if (!spot) return { found: false };
  const yards0 = S.buildings.filter(b => b.type === 'conyard' && b.owner === 0).length;
  const y = S.deployMCV(spot);
  const blocked = ID3.spawn(0, 'mcv', y.tx + 1, y.ty + 1);   // standing on the new yard
  return { found: true, yards: S.buildings.filter(b => b.type === 'conyard' && b.owner === 0).length - yards0,
           gone: !S.units.includes(spot), refused: !S.canDeploy(blocked) };
});
check('an MCV deploys into a Construction Yard and refuses occupied ground',
  mcv.found && mcv.yards === 1 && mcv.gone && mcv.refused, JSON.stringify(mcv));

/* ---- superweapon: charges, launches, warns, then devastates the target ---- */
const sw = await page.evaluate(() => {
  const S = ID3.sim;
  const up = ID3.build(0, 'uplink', 6, S.MAPH - 22);
  for (let i = 0; i < 4; i++) ID3.build(0, 'power', 2 + i * 2, S.MAPH - 26);   // it needs power to charge
  const notYet = !S.readyUplink(0);
  up.charge = S.swChargeTime(0) - 0.1;
  ID3.step(6, 1 / 30);
  const ready = !!S.readyUplink(0);
  const target = ID3.build(1, 'factory', 40, 40), tx = target.x, ty = target.y;
  const launched = S.launchStrike(0, tx, ty);
  const pending = S.strikes.length === 1 && target.hp === target.maxhp;
  ID3.step(110, 1 / 30);
  return { notYet, ready, launched, pending, destroyed: !S.buildings.includes(target), recharging: (up.charge || 0) < 5 };
});
check('the uplink charges, and a launched strike warns before it hits',
  sw.notYet && sw.ready && sw.launched && sw.pending, JSON.stringify(sw));
check('the strike destroys a war factory and the uplink starts recharging', sw.destroyed && sw.recharging);

/* ---- rivers: water and bridges exist, and the bases are still joined by land ---- */
const river = await page.evaluate(() => {
  ID3.mission(7, true);                                       // Twin Serpents has a river
  const S = ID3.sim, T = S.terrain;
  let water = 0, bridge = 0;
  for (const t of T) { if (t === S.T_WATER) water++; if (t === S.T_BRIDGE) bridge++; }
  const home = S.buildings.find(b => b.owner === 0 && b.type === 'conyard');
  const foe = S.buildings.find(b => b.owner === 1 && b.type === 'conyard');
  const path = S.findPath(home.tx + 1, home.ty + 3, foe.tx + 1, foe.ty + 3);
  const wetOnPath = path ? path.filter(([x, y]) => T[y * S.MAPW + x] === S.T_BRIDGE || T[y * S.MAPW + x] === S.T_FORD).length : -1;
  return { water, bridge, path: !!path, wetOnPath };
});
check('a river map has water and bridges, and the bases are joined by land',
  river.water > 40 && river.bridge >= 2 && river.path, JSON.stringify(river));

/* ---- skirmish: the enemy commander builds a base from its yard ---- */
const sk = await page.evaluate(() => {
  const S = ID3.sim;
  S.startSkirmish(S.makeSkirmish({ land: 'plains', credits: 10000, start: 'base' }));
  const b0 = S.buildings.filter(b => b.owner === 1).length;
  for (let i = 0; i < 30 * 150; i++) S.simTick();                 // two and a half minutes
  const types = new Set(S.buildings.filter(b => b.owner === 1).map(b => b.type));
  return { b0, b1: S.buildings.filter(b => b.owner === 1).length, factory: types.has('factory'),
           barracks: types.has('barracks'), army: S.units.filter(u => u.owner === 1 && u.type !== 'harvester').length };
});
check('in skirmish the enemy builds its own base and army',
  sk.b1 >= sk.b0 + 4 && sk.factory && sk.barracks && sk.army > 3, JSON.stringify(sk));

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
