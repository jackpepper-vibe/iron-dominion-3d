# Iron Dominion 3D — Project Notes

Inherits the global guidelines in `../CLAUDE.md` (commercial-grade code, always
commit + push after changes, bypass-permissions bash).

A fork of `../IronDominion`, which is the same game rendered in 2D. The
simulation is shared ancestry and should stay recognisable between the two; the
presentation layer is what diverged. If you fix a *gameplay* bug here, check
whether the 2D original has it too.

## Shape of the code

Still a single self-contained `index.html`, no build step. Three.js is
**vendored** at `vendor/three.min.js` rather than pulled from a CDN — the game
has to work offline as an installed PWA, and the screenshot harness loads the
page over `file://` with no network.

The file is in two halves, and the line between them matters:

- **Above `/* ===== 3D PRESENTATION LAYER ===== */`** is the simulation, carried
  over from the 2D game almost untouched: tile grid, A* pathing, entities with
  world-pixel `x`/`y` and an `angle`, production queues, AI, missions, saves.
- **Below it** is everything that draws. It only ever *reads* sim state. Keeping
  that one-way is what made the port tractable — if you find yourself wanting to
  write to `units` or `terrain` from the renderer, the design has gone wrong.

Build to verify by syntax-checking the inline script:

```
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const re=/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;let m,ok=true;while((m=re.exec(h))){try{new Function(m[1])}catch(e){console.log('ERR:',e.message);ok=false}}console.log(ok?'OK':'FAIL')"
```

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

**The rake is fixed at 52 degrees and does not rotate.** Wheel dollies along it.
This is a deliberate constraint, not an unfinished feature: fixed yaw is what
lets marquee select, the placement ghost, edge scroll and the radar stay simple
and predictable. `R3D` is written so unlocking yaw later is contained, but
everything that consumes `panScale()` and `viewCorners()` would need revisiting.

**Colour space.** The renderer writes sRGB, so Three treats material colours as
already-linear. Every hex in this file is picked by eye as sRGB and must go
through `col()`. Skipping it lifts the whole palette to pale putty — that was
the single biggest visual bug during the port. Light colours are the exception:
they are multipliers, and are set raw.

**Fog of war is a shader, not an overlay.** `shroudify()` patches every world
material with the same shroud sampled by world XZ. Any new material that appears
in the scene must go through `M()` or `shroudify()` or it will glow through the
black and leak the map layout.

## Verification

Screenshots and a smoke test. Do not describe a visual change as done by
reasoning when you can capture it.

```
node scripts/shot.mjs           # mission 1, normal fog
node scripts/shot.mjs 2 reveal  # mission 3, whole map explored
node scripts/smoke.mjs          # picking, orders, marquee, placement, shroud, saves
```

`window.ID3` is the test hook — `mission(i, revealAll)`, `cam(x,y,dist)`,
`look(tx,ty,dist)`, `find(type,dist)`, `spawn`, `build`, `step(n,dt)`,
`theme(i)`. Drive arbitrary states with the shared shot tool:

```
node C:/Claude/Tools/shot/shot.mjs ./index.html --viewport 1280x800 --wait 2500 \
  --eval "document.getElementById('splash').style.display='none';document.getElementById('intro').style.display='none';ID3.mission(0,true)" \
  --eval "ID3.find('conyard',480)" --out shots/base.png
```

`scripts/smoke.mjs` is the one that matters after touching input: the 3D fork
rewrote every path between pointer and simulation, and none of it shows up in a
screenshot.

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
