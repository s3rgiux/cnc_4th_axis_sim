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
generateProgram({design,stock,tools,allowance,strategy,feeds,clearance,grid})
        │   core/toolpath.js — three phases (rough → finish → detail). Each
        │   phase's FLOOR is a tool-offset surface (core/offset.js): tip(X,A) =
        │   lowest tip height at which the cutter volume clears target+allow.
        │   Sweeps are sampled by chordal tolerance (core/adaptive.js);
        │   waterline passes come from core/contour.js.
        │   → { segments:[{mode,X,Z,A,F,group}], … }   (machine-agnostic)
        │   (runs inside app/plan-worker.js in the browser; packed via core/pack.js)
        ▼
emitGcode(program, meta)          core/gcode.js     → text + seg→line map (terminal)
        │
        ▼
CylindricalStock.resize(L,R0,nx,nth)   stock/stock.js   → Float32Array r[i·nth+j]
Simulator.load(program, ctx)           app/sim.js       → distance table, playback
        │   └── setTools({rough,finish,detail}): the cutter actually applied
        │       while a segment of that group plays (flat / ball / vbit)
        │   └── also runs analyzeProgram() once          (core/collision.js)
        │       → sim.analysis {findings, counts, ok, summary}  (advisory only)
        │       → view3d.setCollisions (red overlay) + ui.collisionWarn (amber line)
        │   └── plan-worker 'residue': analyzeResidue()        (core/residue.js)
        │       plays the program through a private Simulator + stock, diffs the
        │       final radii against min(target+finalAllow, R0) → gouge/rest stats,
        │       per-segment `cutgouge` findings (merged into the overlay), and
        │       the 2D residue layer (view2d.setResidue)
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
  offset.js               makeOffsetSurface → {tipAt, upperAt, lowerAt, tipAtBrute}
                          exact per-cell inverse of stock.cutAt for flat/ball/V-bit,
                          + rim-attached samples so the floor is continuous, +
                          pruning bounds (ring/column) so a point costs 2–15 µs
  adaptive.js             adaptiveLine: seed → bisect on chordal deviation →
                          greedy merge; a step in the floor becomes a vertical move
  contour.js              isoContours (edge-chained marching squares, wrapped φ),
                          slopeGrid (steep/shallow split)
  toolpath.js             generateProgram (+ indexed/spiral/helical/hybrid/
                          waterline/raster, constant scallop, air-turn skipping)
  residue.js              buildFloor, residueStats, analyzeResidue
  pack.js                 packProgram / unpackProgram (worker transfer)
  gcode.js                emitGcode, buildSegToLine, fmt1
  collision.js            static advisory checks: rapidsGougeCheck (G0 below the
                          finished surface = gouge; axial G0 below R0+clearance =
                          envelope risk), overtravelCheck (X/Z; A unbounded),
                          aabbVsSweptCylinder (M1 detector, shared with verify.mjs),
                          analyzeProgram → {findings, counts, ok, summary}
src/stock/
  stock.js                CylindricalStock: heightmap, analytic cutting, ΔV
src/app/
  sim.js                  Simulator: distance playback, sub-step cutting, seek,
                          setFloor → segGouge (per-segment gouge attribution)
  plan-worker.js          Worker: 'generate' (design spec → packed program) and
                          'residue' (program + floor grid → analysis)
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

### The tool-offset surface (core/offset.js) — why toolpaths stopped gouging

v1.0 put the tool TIP on `target + allowance`. That is only right where the
surface normal is radial: a ball of radius Rt on a flank of slope β gouges
`Rt(1−cosβ)/cosβ`, a flat endmill `Rt·tanβ` from its corner. Simulated, the
step-shaft lost 7 mm at its shoulders and the diamond pattern 6 mm off its
ridges. `makeOffsetSurface(design, tool, allow, stock, grid)` returns
`tipAt(x, A)` = max over the footprint of the per-cell requirement, where the
requirement is the exact inverse of the matching branch in `stock.cutAt`:

| tool | cell at (Δx, θ) with target T is safe when |
|---|---|
| flat | `Zc ≥ min(T·cosθ, f·cosθ/|sinθ| + M)`, `f = √(Rt²−Δx²)` |
| ball | `Zc+Rt ≥ T·cosθ + √(Rt²−Δx²−T²sin²θ)`, or (radicand < 0) `≥ f/|sinθ| + M` |
| V-bit | cone regime `Zc ≥ T·cosθ − max(0,d−Rt)/tanα`; under the tip flat `Zc ≥ T` |

`M` (0.05 mm) guards the heightmap model's cliffs: at the instant a flat
endmill's plane intersection re-enters the footprint or a ball just grazes a
wall column, the model deletes the whole column above the contact (a heightmap
has no overhangs). Two more details make the surface usable:

- **Rim samples.** Cells alone make the floor a staircase in X and a comb in A
  (a wall-top cell only constrains while it is inside the footprint and its
  ray is within a fraction of a degree of the tool's plane). Evaluating the
  design at points attached to the tool's rim restores continuity; the cells
  stay in the max so the result is still exact against the simulator.
- **Pruning.** Columns and rings are visited outward from the cell under the
  axis with monotone upper bounds (`locMax` window maxima), so a flat region
  costs one ring per column. `tipAtBrute` is the unpruned oracle used in tests.

`adaptive.js` then samples each (X, A) sweep: seed at `angularStep`, bisect
while the mid/quarter points deviate from the chord by more than `tolerance`,
turn a residual step into an explicit vertical move on the safe side, and
greedily merge collinear samples (capped at 10° / 25 mm per block so the
overlays that draw a block as one straight rotor-space line stay honest).
Worst-case simulated gouge is about 3× `tolerance`; `tests/residue.test.mjs`
proves every preset and strategy stays under 0.05 mm.

### CylindricalStock (stock/stock.js)
- Grid `nx × nth`; `radii` is `Float32Array(nx·nth)`, `radii[i·nth+j]` = radius
  at axial column `i` and circumferential sector `j`.
- Resolution is **adaptive**: `config.gridFor(length, R0)` sizes the grid so a
  cell stays ≈ `cellAxial × cellArc` mm (currently 0.9 × 0.65 — doubled vs the
  original fixed 110×120), clamped by `nxMin/nthMin/nxMax/nthMax`. Every
  consumer (stock, mesh import projection, 2D image) takes the grid from there.
- Cutting solves the exact **flat / ball / V-bit** profile intersection
  analytically (no raycasting) and only ever cuts **down** → removal is
  monotone and idempotent. This is what makes backward scrub legal: reset +
  re-apply cutting up to the target distance reproduces any intermediate
  state. The V-bit is a truncated cone: the cut-down radius along a cell ray
  is the largest root of a quadratic (the smaller root is the phantom nappe
  below the apex); rays steeper than the flank are skipped.
- ΔV (volume removed) is accumulated per cut for the "removed cm³" readout.

### Playback (app/sim.js)
- Builds a cumulative arc-length table via `moveDistance`. Playback advances a
  *distance*, not a block index, so speed/scrub are smooth and sub-stepped.
- Rapid vs feed (`G0`/`G1`) selects the rate; the terminal highlights the
  current block through the seg→line map.
- `setTools({rough, finish, detail})` maps each program group to its cutter;
  `_applyRun` cuts with the tool of the playing segment's group, and
  `main.applyPhaseTool` swaps the visible spindle cutter on the same signal.

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
  combo the generator emits is collision-clean), `tests/offset.test.mjs`
  (analytic lifts, pruned-vs-brute oracle, cut-at-offset never gouges, sampler
  step handling), `tests/residue.test.mjs` (every preset and strategy simulates
  gouge-free within 0.05 mm; the legacy tip-on-surface planner is shown to gouge).
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
