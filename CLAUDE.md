# Iron Dominion 3D — Project Notes

Inherits the global guidelines in `../CLAUDE.md` (commercial-grade code, always
commit + push after changes, bypass-permissions bash).

A fork of `../IronDominion`, which is the same game rendered in 2D. The
simulation is shared ancestry and should stay recognisable between the two; the
presentation layer is what diverged. If you fix a *gameplay* bug here, check
whether the 2D original has it too.

## Shape of the code

Still a single `index.html`, no build step. The inline game script is an **ES
module** (`<script type="module">`, `import * as THREE from 'three'`), resolved
by an import map to Three.js **r186 vendored** under `vendor/three-0.186.1/` —
the official npm `build/three.module.js` + `three.core.js`, unmodified. Vendored
rather than CDN so the installed PWA works offline; the version is in the
directory name because `vercel.json` serves `/vendor/*` as `immutable`, so an
upgrade must land at a new path or returning players keep the old build.

Upgrading Three: `npm pack three@<v>`, copy `build/three.module.js`,
`build/three.core.js` and `LICENSE` into `vendor/three-<v>/`, repoint the
import map and the two `modulepreload` links, delete the old directory. There
are no official minified builds any more; don't use jsDelivr's on-the-fly
`.min.js`, which imports the unminified core anyway.

**It must be served.** Browsers refuse module scripts over `file://`.
`npm run serve` (scripts/serve.mjs) serves on :5173; the harnesses start their
own instance on a free port.

**Module scope.** Nothing the game declares is on `window`. Tests reach the
simulation only through `ID3.sim` (accessors for `selection`, `placing`,
`camX`/`camY` so writes hit the live bindings). If a test needs more, add it
there deliberately rather than leaking globals.

The file is in two halves, and the line between them matters:

- **Above `/* ===== 3D PRESENTATION LAYER ===== */`** is the simulation, carried
  over from the 2D game almost untouched: tile grid, A* pathing, entities with
  world-pixel `x`/`y` and an `angle`, production queues, AI, missions, saves.
- **Below it** is everything that draws. It only ever *reads* sim state. Keeping
  that one-way is what made the port tractable — if you find yourself wanting to
  write to `units` or `terrain` from the renderer, the design has gone wrong.

Build to verify with `npm run check` (scripts/check.mjs): parses the inline
module as a module, validates the import map, and checks every vendored path it
and the `modulepreload` links name.

## Things that will bite you

**Coordinates.** Game `x` -> world X, game `y` -> world **Z**, height -> world Y.
A heading of 0 points along +X and increases toward +Z, so a model authored
nose-along-+X is oriented with `rotation.y = -angle`.

**The camera looks north.** It sits on +Z from its focus, facing -Z, so smaller
game `y` is up-screen — the same orientation as the 2D game, the radar and every
mission briefing. Getting this backwards mirrors the whole map and is not
obvious from a screenshot.

**`camX`/`camY` changed meaning.** In the 2D game they were the top-left pixel of
the viewport. Here they are the point on the ground the camera is looking *at*.
Anything doing `mouse.x + camX` is a bug left over from the 2D version.

**The rake is fixed at 40 degrees (was 52 until 2026-09-26; the user wanted a more angled view) and does not rotate.** Wheel dollies along it.
This is a deliberate constraint, not an unfinished feature: fixed yaw is what
lets marquee select, the placement ghost, edge scroll and the radar stay simple
and predictable. `R3D` is written so unlocking yaw later is contained, but
everything that consumes `panScale()` and `viewCorners()` would need revisiting.

**Colour space.** Three's colour management is on: a hex is decoded from sRGB
to linear as it is parsed, and the renderer encodes back to sRGB. Surface
colours go through `col()` (now just `new THREE.Color`, kept as the one choke
point). Light colours are the exception — they are multipliers and are set as
linear (`setHex(hex, LinearSRGBColorSpace)`). Colour canvases used as textures
get `colorSpace = SRGBColorSpace`; the shroud is data and does not.

**Light units.** The theme intensities were graded under r128's legacy lighting,
which r165 removed. `setTheme()` multiplies by `LIGHT_UNIT` (pi) to carry that
grade across unchanged. Grade new lights in physical units and leave the factor
out.

**Fog of war is a shader, not an overlay.** `shroudify()` patches every world
material with the same shroud sampled by world XZ. Any new material that appears
in the scene must go through `M()` or `shroudify()` or it will glow through the
black and leak the map layout.

**Ground = macro + detail.** The 2D painter's `terraCan` is now *broad colour
only*. Fine detail comes from the ground shader: tiling grass/soil detail by
world XZ and triplanar rock picked by the mesh's real slope and height, all
multipliers around mid-grey (`DETAIL_PAINTERS`, generated at start-up). Soil,
mud, road and woodland floor come from `splatCan` (4 texels/tile, blurred, edges
noise-broken in the shader); ore glow from a 72x72 filtered ore map. Never
`fillRect` a whole tile in the painter again — it shows the grid as squares.

**Structures and vehicles.** Author parts in neutral plate (`PLATE*`); each
side is re-skinned by `applyLivery` (Dominion khaki, Scourge gunmetal). Every
non-glow material from `M()` gets the `surfaceify` wear shader (seams, grime,
streaks, dust, worn box edges), keyed by `SURFACE_KIND[hex]` — add a hex there
if it is concrete, earth, shutter, hazard or glass. After a prototype is built,
`mergeStatic` merges every part that does not move into one mesh per
material, so **anything that animates must be tagged** — `userData.tur/rotor/
tailrotor/wheel/ore`, or `ANIM.spin/blink/stack` — or it will be frozen into
the merge. `instantiate()` remaps those tags onto clones.

## Verification

Screenshots and a smoke test. Do not describe a visual change as done by
reasoning when you can capture it.

```
npm run serve                   # http://localhost:5173/
node scripts/shot.mjs           # mission 1, normal fog
node scripts/shot.mjs 2 reveal  # mission 3, whole map explored
node scripts/smoke.mjs          # picking, orders, marquee, placement, shroud, saves
node scripts/look.mjs [--perf]  # REAL-GPU posed captures -> shots/look/, + ms/frame
```

Judge graphics with `look.mjs` only: the other two render on SwiftShader,
which is not what a player sees. `--perf` prints ms, draw calls and triangles.
After the 2026-09-26 structures pass: ~11 ms in play, ~17 ms at full zoom-out
on the Iris Xe, fill-bound (ground shader + shadows), ~280-600 draws.

`window.ID3` is the test hook — `mission(i, revealAll)`, `cam(x,y,dist)`,
`look(tx,ty,dist)`, `find(type,dist)`, `spawn`, `build`, `step(n,dt)`,
`theme(i)`, and `sim` (the simulation state tests may touch). Drive arbitrary
states with the shared shot tool against a running `npm run serve`:

```
node C:/Claude/Tools/shot/shot.mjs http://localhost:5173/index.html --viewport 1280x800 --wait 2500 \
  --eval "document.getElementById('splash').style.display='none';document.getElementById('intro').style.display='none';ID3.mission(0,true)" \
  --eval "ID3.find('conyard',480)" --out shots/base.png
```

`scripts/smoke.mjs` is the one that matters after touching input: the 3D fork
rewrote every path between pointer and simulation, and none of it shows up in a
screenshot.

## Campaign progress

`Campaign` (in index.html) is the only owner of unlocks. It persists
`ironDominion.progress.v2` = `{cleared, best[], difficulty}`: a *count* of
missions cleared in order (never a set of ids, so a bad record cannot skip
ahead) plus the best threat level each was won on. A v1 record
(`{missionMax}`) is migrated on first load. The mission board shows unlocked
missions only; `showBriefing()` refuses a locked index. Each mission's board
card reads `name`, `blurb`, `code` (operation · phase) and `objType` from
`MISSIONS`, so a new mission needs all four.

## What is still 2D on purpose

- **Sidebar icons.** `makeBuildingSprite()` and the vehicle sprite painters are
  kept solely to draw the build icons. They are good art doing a real job at
  188px; rendering icons from the meshes would be more unified and less good.
- **The command overlay.** Brackets, health bars, the marquee and floating
  damage text are drawn flat on `#hud` over the render. Foreshortening them
  with the ground would be more immersive and harder to read.
- **The ground albedo.** The 2D terrain painter still produces `terraCan`, which
  is draped over the heightfield as its colour map. Its baked hillshade was
  removed — real geometry gets real light — but its material ramp survives.

`node_modules/`, `shots/` and `package-lock.json` are gitignored. `vendor/` is
not: the vendored Three.js is part of the app.
