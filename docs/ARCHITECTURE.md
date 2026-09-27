# Architecture

Technical map of the 4th-axis rotary simulator. Read `docs/PLAN.md` for the
build history and `docs/TASKS.md` for what's next.

## The one idea everything hangs on

A cylinder on a rotary axis can be described exactly in **unrolled space**:

```
U = θ · r      arc-length around the circumference   → the A axis
V = Z          position along the axis               → the X axis
depth          how far the tool has cut in radially  → the Z axis
```

So a 3D cylindrical design is *the same information* as a flat 2D heightfield
`(U,V) → depth`. The simulator exploits this three ways:

1. **Design** is a function `targetRadius(u, v)`, not a mesh.
2. **Stock** is a heightmap `r(x, φ)` on a fixed grid — the exact same array
   feeds the 3D mesh *and* the 2D map, so they can never disagree.
3. **Toolpath** is planned as 2D lines then re-rolled with `map2DTo4Axis`.

## Coordinate & world conventions

- Rotary axis = **world X**, the line `y=0, z=0`. Stock occupies `x ∈ [0, L]`.
- Tool axis = **world Z** (vertical). Tool tip sits at `(X, 0, Z)` in world.
- Rotor group spins `rotation.x = −A_rad` so the stock surface tracks the A
  register. `A` is **continuous** (accumulates to thousands of degrees), never
  wrapped, which is why one helical finishing pass is one uninterrupted move.
- Chirality: right-handed around the axis — `x = r·sinφ, z = r·cosφ`. Any
  mesh generator feeding the projector must match this or reliefs mirror.

`core/unroll.js` is the single source of truth for the transforms:
`map2DTo4Axis / map4AxisTo2D`, `uFromA / aFromU`, `surfacePoint`,
`tipToRotor`, `moveDistance` (used for distance-based playback timing),
`wrap / wrapPi / circumference`.

## Data flow (one rebuild)

```
UI params (src/config.js DEFAULTS, edited in src/app/ui.js)
        │
        ▼
makeDesign(design, stock)        core/profiles.js   ── preset / pattern / custom JSON
makeHeightmapDesign(proj,...)    core/mesh.js       ── if an STL/OBJ was imported
        │        └── both produce the SAME interface:
        │            { targetRadius(u,v), profileRadius(v), minTarget(), meta }
        ▼
generateProgram({design,stock,tool,strategy,feeds,clearance})   core/toolpath.js
        │   → { segments:[{mode,X,Z,A,F,group}], … }   (machine-agnostic)
        ▼
emitGcode(program, meta)          core/gcode.js     → text + seg→line map (terminal)
        │
        ▼
CylindricalStock.resize(L,R0,nx,nth)   stock/stock.js   → Float32Array r[i·nth+j]
Simulator.load(program, ctx)           app/sim.js       → distance table, playback
        │   └── also runs analyzeProgram() once          (core/collision.js)
        │       → sim.analysis {findings, counts, ok, summary}  (advisory only)
        │       → view3d.setCollisions (red overlay) + ui.collisionWarn (amber line)
        ▼  (per animation frame, given a pose {X,Z,A,F})
View3D.draw   ── rebuild stock mesh from radii, spin rotor, move cutter
View2D.draw   ── paint radii as heatmap, iso-contour ghost, path lines, cursor
MachineModel.updatePose(X,Z) ── carriage/spindle/tool follow
```

## The design seam (the load-bearing contract)

Everything downstream of *where a design comes from* only ever calls three
methods:

```js
design.targetRadius(u, v)  // mm radius of finished surface at unrolled (u,v)
design.profileRadius(v)    // outer envelope radius for axial slice v (per-row max)
design.minTarget()         // global minimum radius (smallest waist)
design.meta                // { name, ... } for comments/UI
```

Producers: `makeDesign()` (presets + patterns + custom JSON) and
`makeHeightmapDesign()` (mesh import). Consumers: `toolpath.js` (clamps,
stair-step), `view2d.js` (contours), `view3d.js` (ghost). **Adding a new
design source = writing one more producer; nothing else changes.** That is how
part presets (Phase 7) and STL/OBJ import (Phase 8) both landed without
touching the machining core.

## Modules

```
src/core/                 DOM-free, fully unit-tested
  unroll.js               all rotary/unroll transforms (listed above)
  profiles.js             PROFILES, PATTERNS, makeProfileInterpolator, makeDesign
  mesh.js                 parseSTL, parseOBJ, projectToCylinder, makeHeightmapDesign
  toolpath.js             generateProgram (+ indexed/spiral/helical/raster)
  gcode.js                emitGcode, buildSegToLine, fmt1
  collision.js            static advisory checks: rapidsGougeCheck (G0 below the
                          finished surface = gouge; axial G0 below R0+clearance =
                          envelope risk), overtravelCheck (X/Z; A unbounded),
                          aabbVsSweptCylinder (M1 detector, shared with verify.mjs),
                          analyzeProgram → {findings, counts, ok, summary}
src/stock/
  stock.js                CylindricalStock: heightmap, analytic cutting, ΔV
src/app/
  sim.js                  Simulator: distance playback, sub-step cutting, seek
  ui.js                   UI: control panel, transport, DRO, G-code terminal, import
src/scene/
  view3d.js               View3D: rotor, live stock mesh, ghost, path overlays
  view2d.js               View2D: heatmap, target contours, cursor, click-seek
  machine.js              MachineModel: bed/chuck/tailstock + overhead-gantry
                          carriage (posts/bridge clear max swing; Z-feed via
                          telescoping quill). frameMeshes tag = structural
                          members verified collision-free by verify.mjs.
                          (cosmetic — see TASKS.md M-series for realism work)
src/main.js               bootstrap: state, handlers, rebuild() wiring
src/config.js             DEFAULTS for every parameter
```

### CylindricalStock (stock/stock.js)
- Grid `nx × nth`; `radii` is `Float32Array(nx·nth)`, `radii[i·nth+j]` = radius
  at axial column `i` and circumferential sector `j`.
- Cutting solves the exact flat/ball profile intersection analytically (no
  raycasting) and only ever cuts **down** → removal is monotone and
  idempotent. This is what makes backward scrub legal: reset + re-apply
  cutting up to the target distance reproduces any intermediate state.
- ΔV (volume removed) is accumulated per cut for the "removed cm³" readout.

### Playback (app/sim.js)
- Builds a cumulative arc-length table via `moveDistance`. Playback advances a
  *distance*, not a block index, so speed/scrub are smooth and sub-stepped.
- Rapid vs feed (`G0`/`G1`) selects the rate; the terminal highlights the
  current block through the seg→line map.

### Mesh import (core/mesh.js) — the Phase-8 details that matter
- `parseSTL`: binary iff `byteLength === 84 + n·50` (`n = getUint32(80,true)`),
  else ASCII scan of `vertex` lines. `parseOBJ`: `v`/`f` with `v/vt/vn` and
  negative indices, fan-triangulated. Both return `{pos:Float32Array, count}`
  (triangle soup, 9 floats/tri).
- `projectToCylinder`: axis = longest bbox edge; cross-section centre = **vertex
  centroid** (bbox centre drifts on asymmetric silhouettes); `φ = atan2` around
  the axis; uniform radial/axial scale to fit the stock.
- Per-triangle **φ-unwrap** around the widest-radius vertex keeps seam-crossing
  triangles short; the splat then wraps cell indices (`j = floor(fj) mod nth`).
  Barycentric weights use the standard formula; near-axis degenerate vertices
  take the mean of the other two unwrapped φ. Wide triangles recurse-quad-split.
- `makeHeightmapDesign`: bilinear resample (φ wraps, v clamps), floor at
  `0.02·R0`, two smoothing passes (φ-wrap then v-clamped), `profileRadius` =
  row max. Re-instantiated every rebuild so the design adapts to L/D sliders.

## Rendering approach

- **No per-cell objects**: the stock is one `BufferGeometry` rebuilt in place
  from `radii` each frame it changes (guarded by a `version`/dirty check), with
  finite-difference normals → holds 60 fps at 110×120 on a GPU.
- **Path overlays** are three line groups (rapid/rough/finish), each a done +
  all pair using `setDrawRange` for the "machined so far" effect.
- **Path visibility** is `master toolpath switch ∧ per-group checkbox`,
  recomputed by `main.applyPathVisibility()` and pushed to both views at once
  (3D mesh `.visible` + 2D `pathVisible` flag); the master also disables the
  sub-checkboxes so one click always clears the part.
- **2D map**: `radii` written into a tiny `ImageData` and smooth-scaled; a
  marching-squares iso-contour of the target gives the "blueprint before
  cutting" look; a jump-check culls wrap-segment artifacts.

## Testing

- `node --test "tests/**/*.test.mjs"` — pure logic only (no DOM/GL).
  `tests/core.test.mjs` (math/strategies/gcode/stock), `tests/mesh.test.mjs`
  (parse + projection + demo-leg integration incl. seam continuity and feature
  survival), `tests/collision.test.mjs` (gouge/envelope/overtravel detection,
  swept-cylinder AABB, and a false-positive guard proving every rough×finish
  combo the generator emits is collision-clean).
- `verify.mjs` — headless Chrome (playwright-core + swiftshader) drives the
  real UI end to end and writes `shots/*.png`; asserts carve volume removal,
  continuous-A presence, import flow, error reporting, carriage/stock clearance
  (M1, via the shared `collision.aabbVsSweptCylinder` detector + a negative
  control), and the M4 static analysis (live program clean, synthetic
  violations flagged, red overlay rendered).
- Rule of thumb from the build: **geometric/projection bugs get a Node test
  first.** Every projection bug found this cycle (seam smear, barycentric
  weights, centroid drift, chirality) was killed in a unit test, not a browser.

## Build / runtime facts

- Three.js r186.1 **vendored** under `vendor/three/`, loaded via an import map
  in `index.html`. No bundler, no transpile, no install for the app itself.
- `serve.mjs` is a ~60-line static server (path-traversal guarded) that exists
  only because browsers won't `import` over `file://`. STL/OBJ fall through to
  `application/octet-stream`; `fetch` still reads them as bytes.
- Dev-only `node_modules/` (playwright-core) is used by `verify.mjs` and is not
  part of the shipped app.
