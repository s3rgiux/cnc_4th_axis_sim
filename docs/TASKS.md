# Tasks & Backlog

Live task list for the 4th-axis simulator. Completed work is kept (collapsed)
so future contributors can see *why* the code is shaped the way it is; the
**Roadmap** section is the actionable future list. See `docs/PLAN.md` for the
methodology and `docs/ARCHITECTURE.md` for how the pieces fit.

**Verify before/after any change:**
```
node --test "tests/**/*.test.mjs"   # pure-logic suite (currently 30/30)
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
- [x] 2D target iso-contour "blueprint" layer — `scene/view2d.js`
- [x] Node test suite (30) + headless browser `verify.mjs`

---

## Roadmap — prioritized

### 🔴 M-series: machine realism & collisions (the current gaps)

These are all in `src/scene/machine.js` (cosmetic-only today — kinematics are
correct, the *props* just don't sit where a real machine's would). None of
them affect the toolpath math; they affect believability and safety-checking.

**M1 — Carriage must clear the stock's swept circle (the X-move collision).**
- **Symptom:** the carriage ram is a `box(26,30,330)` standing at `y≈0`,
  i.e. dead center in the plane that contains the rotary axis. The spinning
  stock sweeps a cylinder of radius `R0` around world X, so whenever the
  carriage's ram X differs from the cut X, the column visually intersects /
  passes through the part. This is the "lathe colliding with the material"
  report.
- **Real machines:** a 4th-axis router reaches the cylinder from **above** on
  a cantilever / C-frame / gantry whose vertical structure lives entirely
  **outside** the rotation envelope (beyond `y = ±(R0 + clearance)`). The
  spindle approaches along −Z; nothing solid occupies the swept disc.
- **Fix sketch:** rebuild the carriage as an overhead bridge: two side posts
  at `y = ±(maxR0 + margin)` riding the rails, a cross beam above the axis
  (`z ≈ +R0 + headroom`), and the Z-slide + spindle hanging off the beam over
  the work. `updatePose(x,z)` stays the same; only the geometry offsets move.
  Alternatively a rear-mounted C-frame. Acceptance: at any (X,Z) in a full
  program the carriage meshes never overlap a sphere of radius `R0` around the
  X axis between `x=0..L`.
- Touch: `src/scene/machine.js`. Optional `src/config.js` `machine:{}` block
  for clearance/headroom instead of hard-coded constants.

**M2 — Spindle must be visible and read as spinning.**
- **Symptom:** spindle + collet (`cylZ`/cone) sit at local z −26..+9, mostly
  swallowed by the 64 mm `headBox`; at 200 mm scene scale the whole nose is a
  few px and it never rotates.
- **Fix:** shrink/raise the head box so the collet protrudes below it; give
  the spindle its own group that rotates about its axis. Real routers spin the
  cutter very fast (visual blur), so a subtle emissive streak or a hashed
  collet that visibly turns reads better than an accurate-but-invisible part.
- Acceptance: spindle nose + collet clearly visible above the cutter in
  `shots/`; optional spindle-RPM visual toggle.
- Touch: `src/scene/machine.js` (`setTool`, `headZ`, `updatePose`).

**M3 — Tool must be visible during cutting.**
- **Symptom:** the cutter is drawn from the tip plane up 30 mm but is
  immediately overlapped by the head/collet, and a 6 mm ball reads tiny
  against a 200 mm part. In `shots/` it's effectively invisible.
- **Fix:** make the shank exit the collet cleanly (no Z overlap), lengthen the
  exposed flute, and add an optional cut-highlight (brief emissive flash or an
  outline while `F>0` and material is being removed). Consider a chip/spark
  sprite at the tip dot while feeding.
- Acceptance: ball/flat tool silhouette clearly distinguishable from the head
  in a fresh carve screenshot; tool visibly sits in the collet.
- Touch: `src/scene/machine.js`; `src/scene/view3d.js` only if the highlight
  is driven per-frame from the sim's `isCutting` state.

**M4 — Collision detection + reporting (pure module + overlay).**
- New `src/core/collision.js` (DOM-free, unit-tested):
  - **Rapids gouge check:** every `G0` rapid that moves X while `Z` is below
    the current stock surface + clearance can plough into the part. Flag rapid
    segments whose (X,Z) is inside the material envelope. This is a genuine
    programming bug the sim should surface, not just a cosmetic one.
  - **Envelope vs machine:** test machine AABBs (column, head, chuck,
    tailstock) against the swept stock cylinder → drives M1's acceptance test.
  - **Over-travel:** X/Z/A outside machine travel limits.
- Wire: `app/sim.js` runs the rapid check once at `load()` (static), view3D
  tints colliding segments red and paints a marker; `ui.js` shows a status
  warning line. Playback is unaffected — this is advisory.
- Touch: new `core/collision.js` + `tests/collision.test.mjs`; small hooks in
  `sim.js`, `view3d.js`, `ui.js`.

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

- [ ] Add `verify.mjs` assertions that the carriage never intersects the stock
      envelope (turns M1's acceptance into a permanent browser check).
- [ ] `npm test` / `npm run serve` scripts in `package.json` so contributors
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
