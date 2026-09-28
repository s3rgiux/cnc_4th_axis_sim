/**
 * toolpath.js — machining strategy generators.
 *
 * Every strategy plans on the UNROLLED 2D map (U = circumference, V = length)
 * and streams synchronized 4th-axis motion blocks through PathBuilder. The
 * output is machine-agnostic: an ordered list of segments
 *
 *     { mode: 'G0'|'G1', X, Z, A, F, group }
 *
 * with A continuous (never wrapped) so blocks like `G1 X120.5 Z15.2 A1440.0`
 * describe true coordinated X/Z/A motion, exactly as a 4-axis controller
 * consumes them.
 *
 * Floors
 * ------
 * The Z of every cutting move comes from a per-phase FLOOR: by default the
 * tool-offset surface (core/offset.js) — the lowest tip height at which the
 * whole cutter volume clears `target + allowance` — so the flank of a ball,
 * the corner of a flat endmill or the cone of a V-bit never bites into a
 * neighbouring wall. `strategy.offset === false` falls back to the naive
 * tip-on-surface floor (useful for demonstrating why offsets matter).
 *
 * Sampling
 * --------
 * Straight (X, A) sweeps are sampled by chordal tolerance (core/adaptive.js):
 * dense where the floor bends, one long block where it is straight.
 * `strategy.angularStep` is only the coarse seed; `strategy.tolerance` (mm)
 * is the deviation allowed between the programmed chord and the floor.
 *
 * Strategies
 * ----------
 * rough='indexed'  Rotary indexed roughing: descend one depth-of-cut level at
 *                  a time; at each level, rotate the stock to N fixed angles
 *                  and plow straight axial sweeps. Per-station Z is clamped to
 *                  max(level, floor) → stair-step axial clearance.
 * rough='spiral'   Continuous spiral roughing: helix in (X, A) at each level,
 *                  same staircase clamp. Far fewer retract moves.
 * finish='helical' Continuous helical finishing: A turns while X advances;
 *                  Z follows the floor — the showcase of synchronized motion.
 *                  With `strategy.scallop` the pitch shrinks on axial slopes
 *                  (pitch·cosβ) so the scallop height stays constant.
 * finish='raster'  Parallel raster finishing planned purely in 2D: constant-U
 *                  sweeps along V at `stepover` spacing, zig-zag (alternate
 *                  direction) with a skim retract just above the local floor
 *                  between lines instead of a full retract to clearance.
 * finish='waterline' Contour-parallel finishing: iso-height contours of the
 *                  OFFSET surface traced at constant Z, one level per
 *                  `stepover` of radius (core/contour.js). Uniform finish on
 *                  steep walls where a helix leaves tall scallops; sparse on
 *                  shallow areas.
 * finish='hybrid'  Steep/shallow split: the helical pass everywhere, then
 *                  waterline passes only where the offset surface is steeper
 *                  than ~40° (beads, shoulders, the step-shaft walls).
 * rough (spiral)   Turns whose whole X span has the rough floor at or above
 *                  the previous level (`floor.lowerAt`) are air — the earlier
 *                  pass already left nothing there — and are skipped by rapid.
 * detail           Optional third phase: the finishing pass shape again, with
 *                  the smaller detailing tool, its own pitch/feed and its own
 *                  (tighter) allowance — the finishing allowance detailing
 *                  will eat.
 *
 * DOM-free: safe to import from Node tests.
 */
import { uFromA, aFromU, circumference, moveDistance } from './unroll.js';
import { makeOffsetSurface } from './offset.js';
import { adaptiveLine } from './adaptive.js';
import { isoContours, slopeGrid } from './contour.js';
import { gridFor } from '../config.js';

/** Shortest signed rotation (deg) from `current` to `target`'s equivalent. */
export function shortDelta(target, current) {
  let d = (target - current) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

class PathBuilder {
  constructor() {
    this.segs = [];
    this.curX = 0;
    this.curZ = 0;
    this.curA = 0;
  }

  push(mode, X, Z, A, F, group) {
    // Skip zero-length moves to keep the program tight.
    if (X === this.curX && Z === this.curZ && A === this.curA) return;
    this.segs.push({ mode, X, Z, A, F, group });
    this.curX = X;
    this.curZ = Z;
    this.curA = A;
  }

  /** Rapid move; A (if given) is approached via the shortest rotary path. */
  rapid(X, Z, aTarget = null, group = 'rapid') {
    const A = aTarget == null ? this.curA : this.curA + shortDelta(aTarget, this.curA);
    this.push('G0', X, Z, A, 0, group);
  }

  /** Synchronized cutting move at feed F (mm/min). */
  cut(X, Z, aAbs = null, F, group) {
    const A = aAbs == null ? this.curA : aAbs;
    this.push('G1', X, Z, A, F, group);
  }
}

/**
 * Generate the complete machining program.
 *
 * @param {object} input
 * @param {object} input.design    from makeDesign()
 * @param {object} input.stock     { length, R0 }
 * @param {object} input.tools     { rough, finish, detail } each
 *                                 { type:'flat'|'ball'|'vbit', diameter, angle,
 *                                   doc?|stepover? }
 * @param {object} input.allowance { rough, finish, detail } stock left above
 *                                 the design surface after each phase (mm)
 * @param {object} input.strategy  { rough, roughPitch, indexes, finish, pitch,
 *                                   angularStep, detail, detailPitch,
 *                                   tolerance?, scallop?, offset? }
 * @param {object} input.feeds     { rough, finish, detail, rapid }
 * @param {number} input.clearance rapid height above stock radius
 * @param {{nx:number,nth:number}} [input.grid] heightmap resolution used to
 *                                 sample the offset surfaces (default gridFor)
 * @returns {{segments: Array, stats: object, floors: object}}
 */
export function generateProgram({ design, stock, tools, allowance = {}, strategy, feeds, clearance, grid = null }) {
  const { length: L, R0 } = stock;
  const roughT = tools.rough || {};
  const finishT = tools.finish || {};
  const detailT = tools.detail || {};
  const allowRough = Math.max(allowance.rough ?? 0, 0);
  const allowFinish = Math.max(allowance.finish ?? 0, 0);
  const allowDetail = Math.max(allowance.detail ?? 0, 0);
  const Zc = R0 + clearance;               // rapid / clearance height
  const x0 = 0, x1 = L;
  const astep = Math.max(0.25, strategy.angularStep || 2);
  const tol = Math.max(0.002, strategy.tolerance ?? 0.02);
  const useOffset = strategy.offset !== false;
  const sampleGrid = grid || gridFor(L, R0);
  const b = new PathBuilder();

  // ---------------------------------------------------------------- floors
  // One floor per phase: tip height as a function of (X, A).
  const mkFloor = (tool, allow) => {
    if (useOffset) return makeOffsetSurface(design, tool, allow, stock, sampleGrid);
    return {
      tipAt: (x, a) => design.targetRadius(uFromA(a, R0), x) + allow,
      targetAt: (x, a) => design.targetRadius(uFromA(a, R0), x) + allow,
      allow,
    };
  };
  const floors = {
    rough: strategy.rough ? mkFloor(roughT, allowRough) : null,
    finish: mkFloor(finishT, allowFinish),
    detail: strategy.detail ? mkFloor(detailT, allowDetail) : null,
  };

  // Adaptive sampling shared by every sweep: seed spacing = the coarse
  // angular step expressed as arc length (or the tool chord for axial lines).
  const arcSeed = astep * (Math.PI / 180) * R0;
  const sample = (zAt, from, to, coarse) => adaptiveLine(zAt, from, to, {
    tol, minStep: Math.min(0.05, coarse / 4), coarse, maxDX: 25, maxDA: 10, R0,
  });
  /** Emit a cutting sweep from the builder's current pose to (X, A). */
  const sweep = (zAt, X, A, coarse, feed, group) => {
    for (const [x, a, z] of sample(zAt, [b.curX, b.curA], [X, A], coarse)) {
      b.cut(x, z, a, feed, group);
    }
  };

  b.rapid(x0, Zc, 0, 'rapid');

  // ---------------------------------------------------------------- levels
  // Radial step-down levels shared by both roughing strategies. The final
  // level snaps to (min target + rough allowance) so no stub is left for the
  // finishing pass to dig into.
  const minZ = design.minTarget() + allowRough;
  const doc = Math.max(0.2, roughT.doc ?? 3);
  const levels = [];
  if (strategy.rough) {
    for (let zk = R0 - doc; zk > minZ + 1e-6; zk -= doc) levels.push(zk);
    if (!levels.length || levels[levels.length - 1] > minZ + 0.05) levels.push(Math.max(minZ, 0.5));
  }

  /** Staircase clamp: never break past the local rough floor. Levels above
   *  the column's upper bound skip the exact offset evaluation. */
  const effZ = (zk) => {
    const f = floors.rough;
    return f.upperAt
      ? (x, a) => (f.upperAt(x) <= zk ? zk : Math.max(zk, f.tipAt(x, a)))
      : (x, a) => Math.max(zk, f.tipAt(x, a));
  };

  // ------------------------------------------------------- indexed rough
  if (strategy.rough === 'indexed') {
    const Rt = Math.max((roughT.diameter ?? 10) / 2, 0.05);
    const N = Math.max(3, strategy.indexes | 0);
    const chord = Math.max(1.5, Rt * 1.2);
    for (const zk of levels) {
      const zAt = effZ(zk);
      for (let m = 0; m < N; m++) {
        b.rapid(x0, Zc, (360 * m) / N, 'rough');
        b.cut(x0, zAt(x0, b.curA), null, feeds.rough, 'rough'); // radial plunge
        sweep(zAt, x1, b.curA, chord, feeds.rough, 'rough');
        b.rapid(x1, Zc, null, 'rough');     // retract before indexing
      }
    }
  }

  // -------------------------------------------------------- spiral rough
  if (strategy.rough === 'spiral') {
    const pitch = Math.max(0.5, strategy.roughPitch || 4);
    for (const zk of levels) {
      const zAt = effZ(zk);
      const f = floors.rough;
      // A turn is AIR when the rough floor over its whole X span is already
      // at or above the previous level (or the raw stock): the previous pass
      // left nothing above the floor there, so riding the floor again only
      // cuts air. Where the floor is below zk the tool cuts AT zk — that is
      // the real z-level removal and is never skipped.
      const prevLevel = Math.min(R0, zk + doc);
      const airAt = f.lowerAt ? (xa, xb) => {
        const step = Math.max(0.25, (xb - xa) / 16);
        for (let x = xa; x <= xb + 1e-9; x += step) if (f.lowerAt(x) < prevLevel) return false;
        return f.lowerAt(xb) >= prevLevel;
      } : null;
      b.rapid(x0, Zc, null, 'rough');
      helix(zAt, pitch, arcSeed, feeds.rough, 'rough', null, airAt);
      if (b.curZ < Zc) b.rapid(b.curX, Zc, null, 'rough');
    }
  }

  /**
   * One continuous helix from the current X to x1, one revolution per `pitch`
   * of axial travel (the final turn lands exactly on x1). With `slopeOf`,
   * the pitch of each turn shrinks by cos(β) of the steepest axial slope it
   * crosses (constant-scallop), never below pitch/4.
   */
  function helix(zAt, pitch, coarse, feed, group, slopeOf, airAt = null) {
    let X = b.curX, A = b.curA;
    while (X < x1 - 1e-9) {
      let p = pitch;
      if (slopeOf) {
        let gmax = 0;
        for (let k = 0; k <= 4; k++) gmax = Math.max(gmax, slopeOf(Math.min(x1, X + (pitch * k) / 4)));
        p = Math.max(pitch * 0.25, pitch * Math.cos(Math.atan(gmax)));
      }
      const Xn = Math.min(X + p, x1);
      const An = A + 360 * ((Xn - X) / p);
      if (airAt && airAt(X, Xn)) {
        // Nothing to cut on this turn: hop over it at clearance, no rotation.
        if (b.curZ < Zc) b.rapid(X, Zc, null, group);
        b.rapid(Xn, Zc, null, group);
        X = Xn; // A unchanged
        continue;
      }
      if (b.curZ >= Zc - 1e-9) b.cut(X, zAt(X, A), null, feed, group); // plunge back in
      sweep(zAt, Xn, An, coarse, feed, group);
      X = Xn; A = An;
    }
  }

  /** |d profileRadius / dx| at v — the axial slope driving constant scallop. */
  const slopeOf = (v) => {
    const h = Math.max(0.25, L / 400);
    const a = design.profileRadius(Math.max(0, v - h));
    const c = design.profileRadius(Math.min(L, v + h));
    return Math.abs(c - a) / (Math.min(L, v + h) - Math.max(0, v - h));
  };

  // ------------------------------------------------- finishing pass shape
  // Shared by the finishing and detailing phases: same geometry, different
  // tool / feed / pitch / allowance / group tag.
  /**
   * Waterline passes: iso-height contours of the offset (tip) surface at
   * constant Z, every `stepdown` of radius. With `steepOnly`, only the runs
   * where the surface is steeper than `steepTan` are kept.
   */
  const waterline = ({ group, feed, floor, stepdown, steepOnly }) => {
    const { nx, nth } = sampleGrid;
    const dxg = L / (nx - 1), dth = (Math.PI * 2) / nth, degPer = 360 / nth;
    const tg = new Float32Array(nx * nth);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nth; j++) {
        const v = floor.tipAt(i * dxg, j * degPer);
        tg[i * nth + j] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const sd = Math.max(0.1, stepdown);
    const top = Math.min(hi, R0) - 1e-3;
    if (!(top - lo > sd * 0.5)) return; // essentially a cylinder: nothing to contour
    const slope = steepOnly ? slopeGrid(tg, nx, nth, dxg, dth) : null;
    const steepTan = Math.tan(40 * Math.PI / 180);
    const isSteep = (fi, fj) => {
      const i = Math.min(nx - 1, Math.max(0, Math.round(fi)));
      const j = ((Math.round(fj) % nth) + nth) % nth;
      return slope[i * nth + j] >= steepTan;
    };
    const emitRun = (run, closed) => {
      if (run.length < 3) return;
      if (closed) run.push(run[0]);
      const [X0, A0] = run[0];
      if (b.curZ < Zc - 1e-9) b.rapid(b.curX, Zc, null, group);
      b.rapid(X0, Zc, A0, group);                    // shortest rotation to the start
      const off = b.curA - A0;                       // keep the run's unwrapped A continuous
      b.cut(X0, run[0][2], null, feed, group);       // plunge
      let px = X0, pa = A0, pz = run[0][2];
      for (let k = 1; k < run.length; k++) {
        const [X, A, Z] = run[k];
        // Collapse near-collinear vertices (within tol) to keep blocks lean.
        const nxt = run[k + 1];
        if (nxt && k + 1 < run.length) {
          const t = 0.5;
          const mx = px + (nxt[0] - px) * t, ma = pa + (nxt[1] - pa) * t, mz = pz + (nxt[2] - pz) * t;
          const dev = Math.hypot(mx - X, (ma - A) * (Math.PI / 180) * R0, mz - Z);
          const spanA = Math.abs(nxt[1] - pa);
          if (dev < tol && spanA < 10) continue;
        }
        b.cut(X, Z, A + off, feed, group);
        px = X; pa = A; pz = Z;
      }
    };
    for (let lv = top - sd; lv > lo + sd * 0.25; lv -= sd) {
      for (const c of isoContours(tg, nx, nth, lv)) {
        const pts = c.pts.map(([fi, fj]) => {
          const X = Math.min(x1, Math.max(x0, fi * dxg));
          const A = fj * degPer;
          return [X, A, Math.max(lv, floor.tipAt(X, A)), fi, fj];
        });
        if (!steepOnly) { emitRun(pts, c.closed); continue; }
        // Split into steep runs.
        let run = [];
        for (const p of pts) {
          if (isSteep(p[3], p[4])) run.push(p);
          else { emitRun(run, false); run = []; }
        }
        emitRun(run, c.closed && run.length === pts.length);
      }
    }
    if (b.curZ < Zc - 1e-9) b.rapid(b.curX, Zc, null, group);
  };

  const contourPass = (style, { group, feed, floor, pitch, stepover, Rt }) => {
    const zAt = (x, a) => floor.tipAt(x, a);
    if (style === 'waterline') {
      waterline({ group, feed, floor, stepdown: stepover, steepOnly: false });
      return;
    }
    if (style === 'hybrid') {
      contourPass('helical', { group, feed, floor, pitch, stepover, Rt });
      waterline({ group, feed, floor, stepdown: stepover, steepOnly: true });
      return;
    }
    if (style === 'helical') {
      const p = Math.max(0.25, pitch);
      b.rapid(x0, Zc, null, group);
      b.cut(x0, zAt(x0, b.curA), null, feed, group);
      helix(zAt, p, arcSeed, feed, group, strategy.scallop ? slopeOf : null);
      b.rapid(x1, Zc, null, group);
    } else if (style === 'raster') {
      const so = Math.max(0.25, stepover);
      const circ = circumference(R0);
      const chord = Math.max(1.5, Rt * 1.2);
      const skim = Math.max(0.5, Rt * 0.5); // hop height between lines
      let dir = 1;
      let first = true;
      for (let U = 0; U < circ - 1e-6; U += so) {
        const A = aFromU(U, R0);
        const xs = dir > 0 ? x0 : x1, xe = dir > 0 ? x1 : x0;
        if (first) {
          b.rapid(xs, Zc, A, group);
          b.cut(xs, zAt(xs, b.curA), null, feed, group);
          first = false;
        } else {
          // Skim link: lift just above the higher of the two floors, index to
          // the next line, plunge — zig-zag, no round trip to clearance.
          const hop = Math.max(zAt(b.curX, b.curA), zAt(xs, A)) + skim;
          b.cut(b.curX, Math.min(hop, Zc), null, feed, group);
          b.rapid(xs, Math.min(hop, Zc), A, group);
          b.cut(xs, zAt(xs, b.curA), null, feed, group);
        }
        sweep(zAt, xe, b.curA, chord, feed, group);
        dir = -dir;
      }
      b.rapid(b.curX, Zc, null, group);
    }
  };

  contourPass(strategy.finish, {
    group: 'finish',
    feed: feeds.finish,
    floor: floors.finish,
    pitch: strategy.pitch,
    stepover: finishT.stepover ?? 2,
    Rt: Math.max((finishT.diameter ?? 4) / 2, 0.05),
  });

  // ------------------------------------------------------------- detailing
  // A second finishing pass with the small tool: it removes the finishing
  // allowance and leaves only its own (usually near-zero) skin.
  if (strategy.detail) {
    contourPass(strategy.finish, {
      group: 'detail',
      feed: feeds.detail ?? feeds.finish,
      floor: floors.detail,
      pitch: strategy.detailPitch ?? 1,
      stepover: detailT.stepover ?? 0.5,
      Rt: Math.max((detailT.diameter ?? 1) / 2, 0.05),
    });
  }

  // --------------------------------------------------------------- park
  b.rapid(b.curX, Zc, null, 'park');
  b.rapid(x0, Zc, 0, 'park');

  // ---------------------------------------------------------------- stats
  let cutDist = 0, rapidDist = 0, estSeconds = 0, nG1 = 0, nG0 = 0;
  let px = 0, pz = 0, pa = 0;
  for (const s of b.segs) {
    const d = moveDistance(px, pz, pa, s.X, s.Z, s.A);
    if (s.mode === 'G1') { cutDist += d; nG1++; estSeconds += d / Math.max(s.F, 1) * 60; }
    else { rapidDist += d; nG0++; estSeconds += d / Math.max(feeds.rapid, 1) * 60; }
    px = s.X; pz = s.Z; pa = s.A;
  }

  return {
    segments: b.segs,
    stats: { nG1, nG0, cutDist, rapidDist, estSeconds, levels: levels.length },
    floors,
  };
}
