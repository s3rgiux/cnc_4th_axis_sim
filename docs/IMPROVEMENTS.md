# Toolpath & Machining Improvement Plan

Assessment of the toolpath generator as of v1.0 (commit `551451a`), the
alternative approaches that fit this architecture, and the sequence chosen to
implement them. Kept in the repo so future work extends the same path.
Status markers: ✅ done · 🔧 in progress · ⬜ planned · ❌ rejected.

---

## 1. What the v1.0 generator did

`src/core/toolpath.js` was a **drive-surface generator**: every strategy put
the tool **tip** at `targetRadius(u,v) + allowance`, sampled at the tool
centre, and re-rolled (U,V) → (A,X).

| Phase | Strategies | How Z was chosen |
|---|---|---|
| rough | z-level `indexed` sweeps, z-level `spiral` helix | `max(level, target+allowRough)` at the tool **centre** |
| finish / detail | `helical` (constant pitch), `raster` (constant stepover, full retract per line) | `target+allow` at the tool **centre**, constant 2° sampling |

The stock model (`src/stock/stock.js`) simulates the true flat / ball / V-bit
volume, so the simulator *showed* the consequences below, but the collision
module only inspected G0 rapids, so nothing *reported* them.

## 2. Measured shortcomings (v1.0, defaults: 200 × Ø50, spiral rough + helical finish + detail)

Headless simulation with `CylindricalStock` on the adaptive grid; final radii
compared with `target + detailAllowance`:

| Preset | Blocks | Est. time | Max gouge | Max residue |
|---|---|---|---|---|
| classic-leg | 84k | 80 min | 1.12 mm | 3.68 mm |
| step-shaft | 93k | 69 min | **7.11 mm** | 2.90 mm |
| chess-pawn | 102k | 59 min | 1.78 mm | 3.87 mm |
| pulley | 93k | 70 min | 3.23 mm | 1.90 mm |
| classic-leg + diamond pattern | 102k | 143 min | **5.97 mm** (87 % of cells) | 3.47 mm |
| classic-leg, raster finish | 86k | **199 min** | 1.12 mm | 0.09 mm |

Root causes, by impact:

1. **No cutter offset.** Tip-on-surface is only right where the surface normal
   is radial. A ball of radius Rt on a flank of slope β gouges by
   `Rt(1−cosβ)/cosβ`; a flat endmill gouges `Rt·tanβ` from its leading corner
   (the Ø10 rough tool on the step-shaft shoulders eats through the 3 mm
   finish skin). Narrow ridges between pattern grooves are shaved by the ball
   flank while the tip descends into the neighbouring groove.
2. **Blind roughing.** Every z-level sweeps the full length even where the
   target sits at R0 (air cutting); the generator has no in-process stock.
3. **Constant sampling.** 2° per block regardless of curvature → 57k–102k
   blocks; flats over-sampled, beads under-sampled, faceting on tight radii.
4. **Raster linking.** Full retract to clearance + rapid back for every line,
   unidirectional → 2.5× the helical time for the same finish.
5. **Steep walls.** Scallop height of helical/raster grows with slope, so
   shoulders and beads come out coarser than shallow regions.

## 3. Approaches that fit the architecture

All keep the design seam (`targetRadius / profileRadius / minTarget`) and the
segment format `{mode,X,Z,A,F,group}`, so playback, G-code, views and the
collision overlay keep working unchanged.

### A. Offset surface / drop-cutter (Z-map) — fixes 1 — ✅
For each phase, evaluate the **tool-offset surface** `tip(x, A)`: the lowest
tip height such that the tool volume never enters `target + allow` at any
stock cell inside its footprint (classic inverse-offset / Z-map method).
The inverse of each `stock.cutAt` formula gives the exact per-cell lift:
- flat: `min(T·cosθ, √(Rt²−Δx²)·cosθ/|sinθ|)`
- ball: `T·cosθ + √(Rt²−Δx²−T²sin²θ) − Rt` (or "ray misses sphere" when the
  radicand is negative)
- V-bit: `T·cosθ − max(0, d−Rt)/tanα`, `d = √(Δx²+T²sin²θ)`
Evaluated per toolpath point (no interpolation error against the grid).
Module: `src/core/offset.js → makeOffsetSurface(design, tool, allow, stock, grid)`.

### B. Residue / gouge verification map — makes A testable and visible — ✅
Simulate the program headlessly (`src/core/residue.js`, in a Web Worker in the
browser) and diff `radii − min(target+allow, R0)` per cell → max gouge, max
rest material, per-segment attribution. Paint on the 2D map (red = gouge,
blue = rest), add a `cut-gouge` finding kind to the collision advisory, and
turn the table above into a Node test.

### C. Stock-aware (rest) roughing — fixes 2 — 🔧 (air-turn skipping done; rest pass / in-process stock pending)
Keep an in-process `CylindricalStock` in the generator; skip spans already at
or below the level (air cuts), emit rest roughing after finishing where
residue exceeds a threshold, and retract only to `local stock + clearance`.

### D. Waterline (contour-parallel) finishing for steep regions — fixes 5 — ✅
Iso-radius contours of the *offset* surface, traced as coordinated A/X motion
at constant Z, with a steep/shallow split (|∇r| > ~45° → waterline, else
helical). Hoist the marching-squares code from `view2d._buildContours` into
`src/core/contour.js` with edge chaining.

### E. Chordal-tolerance sampling + constant-scallop pitch — fixes 3 and 5 — ✅
Replace the constant `angularStep` with a chordal-deviation tolerance
(subdivide while the chord misses the offset surface by more than `tol`,
merge collinear blocks); vary pitch/stepover with local slope so scallop
height is constant (`s ≈ 2√(2Rt·h)·cosβ`).

### F. Smarter linking — fixes 4 — ✅ (zig-zag + skim links; lead-ins not done)
Zig-zag (bidirectional) raster, skim retracts to the local profile,
shortest-rotation lead-ins.

### G. 2D pocketing / adaptive clearing in unrolled space — ⬜ (later)
At each level the material to remove is `{(u,v): target+allow < level}`; plan
it with offset-contour pocketing or constant-engagement (trochoidal) paths on
the unrolled map and re-roll. Best for hard materials.

### H. Feature-based decomposition: turn the profile, carve the pattern — ⬜ (later)
`profiles.js` already separates `profileRadius(v)` from the pattern. A
lathe-style profile-turning finish handles the axisymmetric body; 4-axis
carving is confined to pattern regions.

### Rejected here — ❌
- 3+1 indexed 3-axis planning: needs a Y axis this machine model lacks.
- Direct triangle-mesh toolpaths for STL import: radial tooling cannot reach
  undercuts anyway; the heightmap projection is the right representation.
- Arc/spline output: controllers linearise blocks that carry an A word.

## 4. Sequence

1. **B** verification map → permanent acceptance test.
2. **A** offset surface, wired into every phase's floor. Acceptance: max gouge
   on every preset < 0.05 mm, residue only where geometry is unreachable.
3. **E** chordal sampling + constant scallop.
4. **D** waterline finish as a third `finish` option.
5. **F / C** linking and stock-aware roughing; **G / H** later.

## 4b. Results after implementation (same measurement as §2)

| Preset / strategy | Blocks | Plan time | Est. time | Max gouge | Max rest (ends excluded) |
|---|---|---|---|---|---|
| classic-leg | 23k | 0.7 s | 125 min | 0.000 | 0.15 mm (Ø1 ball scallop) |
| step-shaft | 26k | 0.8 s | 109 min | 0.000 | 0.32 mm |
| step-shaft, hybrid finish | 36k | 1.0 s | 136 min | 0.000 | 0.25 mm |
| step-shaft, raster finish | 84k | 1.9 s | 177 min | 0.000 | 0.19 mm |
| pulley, indexed rough | 22k | 0.7 s | 103 min | 0.000 | 0.20 mm |
| classic-leg, raster finish | 31k | 0.9 s | 164 min | 0.000 | 0.13 mm |
| classic-leg + diamond | 188k | 14 s | 199 min | 0.000 | 1.8 mm (Ø1 ball cannot enter the cusp) |

Estimated times grew because the defaults now cut a proper finish (detail
pitch 0.5 mm instead of the 1 mm that equalled the Ø1 ball's diameter) and
because the tool actually follows walls instead of ploughing through them.
Lessons worth keeping:

- The heightmap stock model has **cliffs** (no overhangs): a ball grazing a
  wall column or a flat's plane intersection re-entering the footprint deletes
  the column above the contact. Any offset built on it needs a margin there.
- A cell-based offset is a **staircase in X and a comb in A**; sampling the
  design at points attached to the tool rim is what makes it continuous.
- A **step** in the floor must become a vertical move on the safe side; a
  slanted block across it gouges on the high side no matter how fine.
- The sampler's worst-case gouge is ≈ 3 × chordal tolerance, so the default
  tolerance (0.015 mm) is derived from the acceptance threshold (0.05 mm).
  The tolerance is asymmetric (air side 4×): riding a hair above a staircase
  is harmless and halves the block count on walls.
- Steep intervals need a dense interior check at EVERY recursion level; a
  0.6 mm seed interval on a 70° wall can hide a 0.06 mm bump from three probes
  and never get refined at all.

## 5. Verification

```
node --test "tests/**/*.test.mjs"          # residue/offset tests included
node serve.mjs 8090 & node verify.mjs      # browser smoke + screenshots
```
