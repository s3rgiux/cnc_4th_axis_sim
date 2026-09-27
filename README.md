# 4th-Axis Rotary Lathe / Router CNC Simulator

A purely client-side web app that plans toolpaths for a **4th-axis rotary CNC**
by *unrolling* the cylindrical workpiece into a 2D development plane (U,V), then
re-maps them to **synchronized X + Z + A G-code** while simulating real-time
material removal in 3D.

Built with **Three.js** (vendored r186), vanilla ES modules, Canvas2D and plain
DOM. **No build step, no framework, no backend.**

```
                 unrolled design plane                    machine space
        ┌─────────────────────────────┐          ┌──────────────────────────┐
   V ↑  │  plan paths in 2D on the map │  map2D → │  X = V   (axial travel)  │
        │  U = θ·r  (arc length)       │  To4Axis │  Z = R₀ − depth          │
   X →  │  V = Z    (axial length)     │          │  A = U / r · 180/π  (°)  │
        └─────────────────────────────┘          └──────────────────────────┘
```

* **U** — circumference arc coordinate `θ·r` (the unrolled horizontal)
* **V** — axial coordinate, becomes machine **X**
* **Z** — radial depth from the rotation axis (`R₀ − depth`)
* **A** — rotary table angle, **continuous** (never wrapped — `A1440.0` is a real
  4-turn block, exactly like a TrueSync / simultaneous-4-axis controller)

## Documentation

- **[`docs/PLAN.md`](docs/PLAN.md)** — the build plan that was followed, phase
  by phase, and the working method for future milestones.
- **[`docs/TASKS.md`](docs/TASKS.md)** — completed list + prioritized backlog.
  The next milestone (**M-series: machine realism & collision detection**)
  covers the currently-visible gaps: the carriage/ram intersecting the stock on
  X moves, and the spindle/tool being hard to see.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — module map, the
  design-as-function seam, data flow, and the mesh-import projection details.

## Quick start

```bash
npm run serve          # zero-dependency Node static server → http://127.0.0.1:8090
npm test               # 44 unit tests for core math / strategies / stock / collisions
```

ES modules do not run from `file://`, hence the tiny static server — the app
itself is 100% client-side (host `index.html` on any static file host).

Optional headless smoke test (dev-only; needs a local Chrome, installed with
`npm i --no-save playwright-core`):

```bash
node verify.mjs        # boots the UI, plays, seeks, switches strategies, screenshots to shots/
```

## Using the simulator

1. **Stock** – length / diameter of the round bar in the chuck centres.
2. **Design** – pick a turning profile (classic legs, beads & coves, or part
   shapes: **baseball bat, chess pawn, bottle, spool, spinning top, stepped
   shaft, V-belt pulley**) and an optional spiral surface pattern, or paste
   a custom JSON:
   ```json
   { "profile": [[0,25],[80,18],[140,22],[200,10]],
     "pattern": "spiral", "patternCount": 6, "patternTurns": 2, "patternDepth": 0.22 }
   ```
3. **Phases & tools** – three passes, each with its own (progressively smaller)
   cutter and its own **allowance** — the stock left standing above the design
   surface after that phase: **roughing** Ø10 flat endmill → leave 3 mm,
   **finishing** Ø4 ball-nose → leave 0.5 mm, **detailing** Ø1 ball-nose →
   leave 0.1 mm (set 0 to cut to exact design). Every phase picks *flat
   endmill / ball-nose / **V-bit*** (engraving cone — choose the included
   angle); each section shows a live cross-section preview with dimensions.
4. **Strategy** – roughing *off / indexed faceting sweeps / spiral helix* plus
   finishing *continuous helical* or *raster (parallel 2D passes)*; detailing
   replays the finishing shape with the small tool. Each phase stair-steps at
   `target + its own allowance`, so no phase ever digs into the next one's
   skin, and the spindle visibly swaps cutters as each phase plays.
5. **⚙ Generate Toolpath** then press **▶** (Space). Scrub with the timeline,
   step one block with ◀▮ / ▮▶, click anywhere in the 2D map to jump there.
   **⬇ Export G-code** downloads `part.nc`.
6. **Collision advisory** — every generated program is statically checked:
   rapids that break below the finished surface or travel axially inside the
   raw-stock envelope, and X/Z overtravel are listed on an amber warning line
   and painted red in the 3D view. Advisory only — playback is never blocked.

### Importing a real 3D model (STL / OBJ)

The **Design** panel also turns an arbitrary triangular mesh into a machining
plan — the same `U = θ·r`, `V = Z` unroll used everywhere else, run in reverse:

1. Click **Import STL/OBJ** (or drag a `.stl`/`.obj` file anywhere onto the
   page). Binary and ASCII STL and Wavefront OBJ are parsed in-browser — no
   backend, no upload.
2. **Demo: baroque leg** loads `assets/table-leg.stl`, a procedurally generated
   cabriole leg (volute, spiral acanthus, reeding, diamond quarry, ball-and-claw)
   so you can see the whole pipeline without a file to hand. Regenerate it with
   `node scripts/make-demo-leg.mjs`.
3. The mesh is projected onto the stock cylinder as a **max-envelope heightmap**:
   the longest bbox edge becomes the axis, the vertex centroid its centre, and
   for every surface point the *outermost* radius at that `(θ, Z)` is kept, so
   bumps and carved reliefs survive (a min/average envelope would flatten them).
   The result feeds `targetRadius(u, v)` exactly like a built-in profile, so
   roughing, finishing, playback and G-code all work unchanged.

Notes: the surface-pattern fields are ignored for an imported design (the model
*is* the surface); a ball-nose leaves residue in valleys narrower than its
radius, so widen stepover or use a smaller tool for dense relief; very deep
undercuts can't be reached by a radial tool and are clipped to the tool path.

Views: **3D Rotary View**, **Unrolled 2D Flat View** (the live material state of
the very same heightmap), or **Split**. Toggles for target ghost (an iso-contour
blueprint of the unrolled part, in both 2D and 3D) / rough / finish / detail
paths and a rapids overlay (off by default — there are a lot of them). The
master **toolpath**
checkbox (or the **P** key) hides *every* path trace at once in both views — the
fast way to see the finished part unobstructed; the per-group boxes then act as
sub-layers under it. Double-click the 3D view to re-frame.

## Architecture

```
index.html, styles.css      shell, import map for vendored three.js
serve.mjs                   dev static server (path-traversal guarded)
vendor/three/               three.module.js + core + OrbitControls (r186.1)
src/config.js               DEFAULTS for every UI parameter (3 phases × tool/allowance)
src/core/                   DOM-free pure logic (fully unit-tested)
  unroll.js                 U=θr ↔ X/Z/A transforms, moveDistance, wrap helpers
  mesh.js                   STL/OBJ parsers + cylindrical max-envelope projection
                            → imported heightmap design (same targetRadius seam)
  profiles.js               profile presets, spiral patterns, custom-JSON parser,
                            monotone-cubic interpolator → targetRadius(U,V)
  toolpath.js               strategy generators → {mode,X,Z,A,F,group} segments
  gcode.js                  post-processor: merged axis words per block,
                            continuous A, header/footer, seg→line map
  collision.js              static advisory checks: rapid gouge/envelope,
                            overtravel, AABB-vs-swept-cylinder (M1 detector)
src/stock/stock.js          cylindrical heightmap r(x,φ); analytic flat/ball/
                            V-bit cut-down roots; monotone removal; ΔV accounting
src/app/sim.js              distance-based playback, sub-stepped cutting,
                            backward-seek by re-simulation
src/app/ui.js               control panel, transport, DRO, live G-code terminal
src/scene/view3d.js         Three.js viewport: rotor group, stock mesh rebuilt
                            per frame, ghost, path overlays
src/scene/machine.js        stylized bed / headstock / tailstock / carriage /
                            spindle + cutter that follows the machine pose
src/scene/view2d.js         unrolled map canvas: removal heatmap, target
                            iso-contour ghost, path lines, live tool cursor,
                            click-to-seek
tests/core.test.mjs         node:test suite (math, strategies, G-code, stock)
tests/mesh.test.mjs         STL/OBJ parse, cylinder projection, demo-leg import
tests/collision.test.mjs    rapid gouge/envelope, overtravel, swept-cylinder AABB
scripts/make-demo-leg.mjs   generates assets/table-leg.stl (baroque demo model)
verify.mjs                  optional headless browser smoke test
```

Key rendering trick: the stock **is** the 2D map. `CylindricalStock` stores
`r(x, φ)` on the same grid the unrolled view draws, so one Float32Array feeds
both the 3D mesh (with analytic finite-difference normals) and the 2D heatmap —
they can never disagree.

## G-code conventions

```
%                         G21 absolute mm, G94 mm/min, A continuous
G1 A0                     rotary zero
G0 Z24.7                  retract above stock (R₀ + clearance)
G1 X8.0 Z24.7 A44.0 F1200 synchronized 4-axis helix — A accumulates
...
G1 X200.0 Z22.9 A24000.0  helical finish: X = pitch · ΔA / 360
M30
```

**Safety note:** this is a planner/visualiser. Always verify generated code
with a dedicated simulator and dry-run (single block, rapid override, tool
off the stock) before putting it on a real machine; verify feed/speed, post
format and rotary limits for your specific controller.

## Performance

~13k stock vertices rebuilt every frame plus a 110×120 heatmap redraw:
comfortably 60 fps on any GPU-accelerated browser (the headless CI checks here
run on SwiftShader software GL and still drive the full app at ~11 fps).

## License

MIT
