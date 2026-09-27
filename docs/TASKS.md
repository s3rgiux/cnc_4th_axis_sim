# Tasks & Backlog

Live task list for the 4th-axis simulator. Completed work is kept (collapsed)
so future contributors can see *why* the code is shaped the way it is; the
**Roadmap** section is the actionable future list. See `docs/PLAN.md` for the
methodology and `docs/ARCHITECTURE.md` for how the pieces fit.

**Verify before/after any change:**
```
node --test "tests/**/*.test.mjs"   # pure-logic suite (currently 44/44)
node serve.mjs 8090 & node verify.mjs   # headless browser smoke test
```

---

## Done (v1.0)

- [x] Coordinate/unroll math `U=θr ↔ X/Z/A`, continuous A — `core/unroll.js`
- [x] Design-as-function seam: `targetRadius(u,v) / profileRadius(v) / minTarget()`
- [x] Turning profiles (classic legs) + surface patterns + custom JSON
- [x] Part-shape presets: bat, pawn, bottle, spool, top, stepped shaft, pulley
- [x] Cylindrical heightmap stock with analytic flat/ball cutting, monotone
      removal, live 3D + 2D sharing one Float32Array — `stock/stock.js`
- [x] Roughing (indexed faceting with stair-step axial clamp, spiral helix) +
      finishing (continuous helical, raster) — `core/toolpath.js`
- [x] G-code post with continuous A, `.nc` export, terminal with active-line
- [x] Distance-based playback, step/scrub/reset, backward-seek by re-sim
- [x] 3D Rotary View / Unrolled 2D Flat View / Split, target ghost, path overlays
- [x] STL/OBJ import → max-envelope cylindrical heightmap → carve (zero core
      changes) — `core/mesh.js`, `src/main.js`, `src/app/ui.js`
- [x] Procedural baroque demo leg `assets/table-leg.stl` — `scripts/make-demo-leg.mjs`
- [x] Overlay toggles now drive both views; rapids toggle (off by default)
- [x] Master **toolpath** switch (checkbox + `P` key) hides all path traces in
      both views at once so the finished part reads clean; per-group checkboxes
      are sub-layers under it (dimmed while off) — `main.applyPathVisibility()`
- [x] 2D target iso-contour "blueprint" layer — `scene/view2d.js`
- [x] Node test suite (30) + headless browser `verify.mjs`

---

## Roadmap — prioritized

### 🔴 M-series: machine realism & collisions (the current gaps)

These are all in `src/scene/machine.js` (cosmetic-only today — kinematics are
correct, the *props* just don't sit where a real machine's would). None of
them affect the toolpath math; they affect believability and safety-checking.

**M1 — Carriage must clear the stock's swept circle (the X-move collision). ✅ DONE.**
- Was: a ram column standing at `y≈0`, dead center in the plane containing the
  rotary axis — the carriage visually passed through the spinning stock on
  every X move.
- Now: the carriage is an overhead gantry (`src/scene/machine.js`). Side
  posts at `y = ±90` (inner faces 82 > max stock radius 60 = Ø120 slider
  limit) ride the bed; the bridge spans `z 156..184` above the work; the
  spindle housing + nose are fixed under the bridge; a telescoping quill +
  collet + cutter on the moving `headZ` feed along −Z to the tip. `updatePose`
  signature unchanged — it drives `carriage.x`, `headZ.z` and the quill
  extension. Structural members are tagged in `machine.frameMeshes`.
- Bonus fix found in the same sweep: `cylZ()` never rotated its geometry, so
  the spindle/collet/cutter lay along world **Y** (a big reason the tool read
  as invisible). All Z-axis cylinders now bake `rotateX(π/2)` into vertices;
  the tool stack (cutter → collet → quill → nose → housing) is genuinely
  vertical.
- Acceptance is now a permanent `verify.mjs` step: every frame member's AABB
  stays outside the swept cylinder across full travel for
  {L200×Ø50, L360×Ø120, L10×Ø6}, plus a negative control proving the detector
  fires.

**M2 — Spindle must read as spinning.** (visibility half ✅ done by M1)
- M1's rebuild already fixed visibility: the housing/nose sit fixed under the
  bridge well above the work and the collet + quill protrude cleanly below.
  What remains is motion — give the quill/collet/cutter a spin about Z while
  `F>0` (or an emissive-streak / hashed-collet trick; real router RPM blurs
  anyway, so a stylized spin reads better than an accurate invisible one).
- Acceptance: visible spin in a cutting screenshot or toggleable
  spindle-RPM visual.
- Touch: `src/scene/machine.js` (+ tiny rAF dt hook from `view3d.js`).

**M3 — Tool must be clearly distinguishable while cutting.** (visibility ✅ done by M1; highlight pending)
- The Z-orientation bug fix means the cutter now hangs visibly below the
  collet with a clean tip dot; shots confirm it reads against the work.
  Remaining niceties: an optional cut-highlight (emissive flash or outline
  while material is being removed) and maybe a chip sprite at the tip.
- Acceptance: tool visibly sits in the collet (done); optional highlight
  toggle works while `F>0`.
- Touch: `src/scene/machine.js`; `src/scene/view3d.js` only if the highlight
  is driven per-frame from the sim's `isCutting` state.

**M4 — Collision detection + reporting (pure module + overlay). ✅ DONE.**
- New `src/core/collision.js` (DOM-free, 14 unit tests in `tests/collision.test.mjs`):
  - **Rapids gouge:** any `G0` whose tip breaks below `design.targetRadius`
    (the finished surface) can never be legitimate — flagged per block. This
    includes rapids that *start* below the surface and travel X.
  - **Rapids in envelope:** axial `G0` (ΔX > 0.05) below `R0 + clearance`
    ploughs into possibly-uncut stock. Pure radial retracts (ΔX ≈ 0) are the
    normal way out of a groove and are exempt — the generator keeps every
    axial rapid at Zc, so a flag here means a real risk.
  - **Overtravel:** X/Z outside `config.js → machine` travel limits. A is
    deliberately unbounded: continuous multi-turn rotary is the feature.
  - **Machine envelope:** `aabbVsSweptCylinder` — M1's detector extracted
    into the pure core; `verify.mjs` now feeds it the live carriage AABBs, so
    the browser check and the Node tests share one source of truth.
- Wiring: `sim.load(program, {design, clearance, limits})` runs the analysis
  once at load → `sim.analysis`; `view3d.setCollisions` paints offending
  segments red (rotor space, depth-test off) with marker dots; `ui.collisionWarn`
  shows a persistent amber line naming the first offending G-code line.
  Playback is never affected — this is advisory.
- Acceptance: the Node suite proves all rough×finish combos generate clean
  programs (false-positive guard) and that synthetic gouge/envelope/overtravel
  programs fire; `verify.mjs` M4 section re-checks live + synthetic in the
  browser and screenshots the red overlay (`shots/10-collision-overlay.png`).

### 🟠 Feature ideas

- **Tool library / quick tool change** — several tools per program with an
  M06-style change and per-tool feeds; stock keeps state across changes.
- **Stock-from-mesh** — import an STL as the *raw blank* (not just the target
  design), e.g. a casting with excess material.
- **Dry-run / single-block / feed-override %** on the transport bar.
- **Imperial units toggle** (in/mm) across config, UI, G-code comment header.
- **Cutting-force / load estimate** per block → colour the toolpath by feed
  load to teach feed/speed intuition.
- **A-axis backlash & wrap visualization** — show that A is continuous by
  drawing the accumulated-turn count near the DRO (already tracked).

### 🟡 Mesh-import refinements

- **Progress indicator** for large STLs (multi-MB) — projection is O(tris);
  show a percentage instead of the single "Importing…" paint.
- **Fit options UI** — let the user lock which bbox axis becomes the rotary
  axis, override center, and choose max vs min envelope (currently auto).
- **Undercut mask** — highlight regions a radial ball-nose physically cannot
  reach (negative draft) directly on the 2D map.
- **OBJ material groups / multi-part meshes** — currently merged to one cloud.

### 🟢 Housekeeping / QA

- [x] Add `verify.mjs` assertions that the carriage never intersects the stock
      envelope (turns M1's acceptance into a permanent browser check).
- [x] `npm test` / `npm run serve` scripts in `package.json` so contributors
      don't need to remember the node invocations.
- [ ] Trim vendored three.js to the used modules to shrink the payload.
- [ ] Accessibility: aria-labels on transport + DRO live region.

---

## Conventions for picking up a task

1. Pure logic → new file in `src/core/` **with tests first**, then wire it.
2. Visuals only → `src/scene/**`; keep kinematics in `sim`/`stock` untouched.
3. New default → add to `src/config.js`, seed the UI from it.
4. Run the two verify commands at the top; refresh `shots/` via `verify.mjs`
   when a change is meant to be seen.
