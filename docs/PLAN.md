# Project Plan — 4th-Axis Rotary Lathe/Router Simulator

The plan that was actually followed to build the simulator as it stands today.
Kept here so future milestones can extend the same path instead of inventing a
new one. Current status: **v1.0 complete** — see `docs/TASKS.md` for the
backlog (machine realism, collision detection, spindle/tool visibility).

## 1. Goal

A browser-based, zero-backend simulator that proves the core workflow of a
4th-axis (rotary) CNC:

> **3D design → unrolled 2D toolpath plan → back to 3D carving**

Key identity: for a cylinder on the rotary axis, unrolling is exact and
lossless in the (θ, Z) domain — `U = θ·r` (arc-length around), `V = Z`
(along the axis) — so any cylindrical surface can be planned as a flat 2D
bitmap and re-rolled by the machine: `map2DTo4Axis(u, v, depth, R)` →
`{X: v, Z: R − depth, A: u/r·180/π}` with **continuous** (multi-turn) A.

## 2. Constraints (decided up front, still binding)

| Constraint | Choice |
|---|---|
| Backend | None. Static files only; a tiny `serve.mjs` exists solely because browsers block ES modules over `file://`. |
| Dependencies | Three.js (vendored r186.1, import map). No bundler, no build step. |
| Modules | ES modules throughout; `src/core/**` is DOM-free and unit-tested with `node:test`. |
| Performance | 60 fps target on GPU; stock heightmap 110×120 cells so per-frame mesh rebuild stays cheap. |
| Machine model | Rotary axis = world **X**; tool axis = world **Z** (vertical through y=0, z=0 at the axis). Rotor spins `rotation.x = −A_rad`. |

## 3. Phases (as executed)

### Phase 0 — foundations
- Coordinate/unroll math (`core/unroll.js`): `A↔U`, `X↔V`, arc metrics,
  angle wrapping, continuous-A accumulation.
- Default machine parameters (`src/config.js`) — every UI field seeds from here.

### Phase 1 — design as a function, not a mesh
- The pivotal decision: **a design is just `targetRadius(u, v)`** plus
  `profileRadius(v)` (outer envelope per axial slice) and `minTarget()`.
- Profiles built from monotone-cubic-interpolated control points
  (`core/profiles.js`), surface patterns (none/grooves/spiral/flute/knurl…)
  layered on top in unrolled space, custom-JSON escape hatch.
- *Why this matters:* every later feature (presets, mesh import) only needed
  a new producer for the same 3-method interface — zero changes to toolpath,
  stock, playback, or views.

### Phase 2 — material that actually disappears
- `stock/stock.js`: cylindrical heightmap `r(x, φ)` on the **same grid** the
  2D map draws (one Float32Array feeds 3D mesh + 2D heatmap; they can never
  disagree). Analytic flat/ball cut-down roots; removal is monotone +
  idempotent, which makes *backward* playback legal by re-simulation.

### Phase 3 — toolpath strategies (`core/toolpath.js`)
- Roughing: **indexed faceting** (discrete A stations, stair-step axial clamp
  that never breaks below `target + allowance`) and **spiral helix**.
- Finishing: **continuous helical** (A accumulates for thousands of degrees)
  and **raster** (parallel 2D passes re-rolled).
- Output: flat `{mode, X, Z, A, F, group}` segment list — machine-agnostic.

### Phase 4 — post-processor (`core/gcode.js`)
- Merged axis words per block, continuous A values, header with stock/tool/
  strategy comments, seg→line map so the terminal highlights the active block.
- `.nc` download.

### Phase 5 — views & playback
- `app/sim.js`: distance-based playback with sub-stepped cutting; scrubbing
  backward = reset + re-simulate to that distance (idempotency from Phase 2).
- `scene/view3d.js`: rotor group, live stock mesh, target ghost, path overlays
  (all/done draw ranges per group).
- `scene/view2d.js`: the same heightmap as an unrolled map — removal heatmap,
  iso-contour target ghost, path lines, live tool cursor, click-to-seek.
- `scene/machine.js`: stylized bed / headstock / tailstock / carriage that
  follows the pose. *(Cosmetic in v1 — realism & collision are the next
  milestone, see TASKS.md M-series.)*

### Phase 6 — verification harness (kept from day one)
- `node --test tests/*.test.mjs` — pure-logic tests (math, strategies,
  gcode, stock monotonicity).
- `verify.mjs` — headless Chrome (playwright-core + swiftshader) smoke test:
  boot, render, carve, scrub, strategy switch, import flow, screenshots to
  `shots/`. Run with the server up: `node serve.mjs 8090 && node verify.mjs`.

### Phase 7 — content: part-shape presets
- Baseball bat, pawn, bottle, spool, top, stepped shaft, pulley — pure
  `profiles.js` data, zero new machinery (validates the Phase 1 seam).

### Phase 8 — imported real 3D models (STL/OBJ → unroll → carve)
- `core/mesh.js`: binary/ASCII STL + OBJ parsers; **max-envelope cylindrical
  projection** (longest bbox edge → axis, vertex centroid → center, outermost
  radius per (θ,Z) cell wins so relief survives); per-triangle φ-unwrap to
  keep seam triangles continuous; barycentric splat with recursive quad-split
  for wide triangles; wrapped smoothing passes.
- `makeHeightmapDesign` re-materializes the projection for the *current*
  stock L/D on every rebuild — imported designs adapt to sliders.
- `scripts/make-demo-leg.mjs` generates `assets/table-leg.stl` (procedural
  baroque cabriole leg) so the whole pipeline demos with no user file.
- Chirality note: generators must use right-handed `x=r·sinφ, z=r·cosφ`
  around the axis to match `atan2` in the projector (a mirrored generator
  silently produces mirrored reliefs).

## 4. Working method (also for future tasks)

1. Core logic first as a pure module in `src/core/` — with tests, before UI.
2. Wire to UI through the smallest possible seam (e.g. designs are consumed
   only via `targetRadius/profileRadius/minTarget`).
3. `node --test "tests/**/*.test.mjs"` after each step; `node verify.mjs`
   before declaring a feature done; eyeball the screenshots in `shots/`.
4. Visual/geometric bugs: reproduce in a pure test first (all projection bugs
   this session were killed in Node, not in the browser).
