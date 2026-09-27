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
 * Strategies
 * ----------
 * rough='indexed'  Rotary indexed roughing: descend one depth-of-cut level at
 *                  a time; at each level, rotate the stock to N fixed angles
 *                  and plow straight axial sweeps. Per-station Z is clamped to
 *                  max(level, target+allowRough) → stair-step axial clearance.
 * rough='spiral'   Continuous spiral roughing: helix in (X, A) at each level,
 *                  same staircase clamp. Far fewer retract moves.
 * finish='helical' Continuous helical finishing: A turns at constant pitch
 *                  while X advances; Z traces r_target(U(A), X) sampled every
 *                  `angularStep` degrees — the showcase of synchronized motion.
 * finish='raster'  Parallel raster finishing planned purely in 2D: constant-U
 *                  sweeps along V at `stepover` spacing, each re-mapped to a
 *                  fixed A index with Z flying over the target surface.
 * detail           Optional third phase: the finishing pass shape again, with
 *                  the smaller detailing tool, its own pitch/feed and its own
 *                  (tighter) allowance — the finishing allowance detailing
 *                  will eat.
 *
 * DOM-free: safe to import from Node tests.
 */
import {
  uFromA,
  aFromU,
  circumference,
  moveDistance,
} from './unroll.js';

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
 *                                   angularStep, detail, detailPitch }
 * @param {object} input.feeds     { rough, finish, detail, rapid }
 * @param {number} input.clearance rapid height above stock radius
 * @returns {{segments: Array, stats: object}}
 */
export function generateProgram({ design, stock, tools, allowance = {}, strategy, feeds, clearance }) {
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
  const b = new PathBuilder();

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

  /** Staircase clamp: never break past the local target + rough allowance. */
  const effZ = (zk, u, v) => Math.max(zk, design.targetRadius(u, v) + allowRough);

  // ------------------------------------------------------- indexed rough
  if (strategy.rough === 'indexed') {
    const Rt = Math.max((roughT.diameter ?? 10) / 2, 0.05);
    const N = Math.max(3, strategy.indexes | 0);
    const chord = Math.max(1.5, Rt * 1.2);
    for (const zk of levels) {
      for (let m = 0; m < N; m++) {
        b.rapid(x0, Zc, (360 * m) / N, 'rough');
        const U = uFromA(b.curA, R0);       // map position under the tool
        b.cut(x0, effZ(zk, U, x0), null, feeds.rough, 'rough'); // radial plunge
        for (let x = x0 + chord; x < x1; x += chord) {
          b.cut(x, effZ(zk, U, x), null, feeds.rough, 'rough');
        }
        b.cut(x1, effZ(zk, U, x1), null, feeds.rough, 'rough');
        b.rapid(x1, Zc, null, 'rough');     // retract before indexing
      }
    }
  }

  // -------------------------------------------------------- spiral rough
  if (strategy.rough === 'spiral') {
    const pitch = Math.max(0.5, strategy.roughPitch || 4);
    for (const zk of levels) {
      b.rapid(x0, Zc, null, 'rough');
      b.cut(x0, effZ(zk, uFromA(b.curA, R0), x0), null, feeds.rough, 'rough');
      const aStart = b.curA;
      const total = 360 * Math.ceil((x1 - x0) / pitch);
      const n = Math.ceil(total / astep);
      let prevDa = 0;
      for (let i = 1; i <= n; i++) {
        const da = Math.min(i * astep, total);
        if (da === prevDa) continue;
        const X = Math.min(x0 + (pitch * da) / 360, x1);
        const a = aStart + da;
        b.cut(X, effZ(zk, uFromA(a, R0), X), a, feeds.rough, 'rough');
        prevDa = da;
        if (X >= x1) break;
      }
      b.rapid(x1, Zc, null, 'rough');
    }
  }

  // ------------------------------------------------- finishing pass shape
  // Shared by the finishing and detailing phases: same geometry, different
  // tool / feed / pitch / allowance / group tag.
  const contourPass = (style, { group, feed, allow, pitch, stepover, Rt }) => {
    const floor = (u, v) => design.targetRadius(u, v) + allow;
    if (style === 'helical') {
      const p = Math.max(0.25, pitch);
      b.rapid(x0, Zc, null, group);
      b.cut(x0, floor(uFromA(b.curA, R0), x0), null, feed, group);
      const aStart = b.curA;
      const total = 360 * ((x1 - x0) / p);
      const n = Math.ceil(total / astep);
      let prevDa = 0;
      for (let i = 1; i <= n; i++) {
        const da = Math.min(i * astep, total);   // final block lands exactly on x1
        if (da === prevDa) continue;
        const X = Math.min(x0 + (p * da) / 360, x1);
        const a = aStart + da;
        b.cut(X, floor(uFromA(a, R0), X), a, feed, group);
        prevDa = da;
      }
      b.rapid(x1, Zc, null, group);
    } else if (style === 'raster') {
      const so = Math.max(0.25, stepover);
      const circ = circumference(R0);
      const stepV = Math.max(1.5, Rt * 1.2);
      for (let U = 0; U < circ - 1e-6; U += so) {
        b.rapid(x0, Zc, aFromU(U, R0), group);   // index rotary to this raster line
        b.cut(x0, floor(U, x0), null, feed, group);
        for (let x = x0 + stepV; x < x1; x += stepV) {
          b.cut(x, floor(U, x), null, feed, group);
        }
        b.cut(x1, floor(U, x1), null, feed, group);
        b.rapid(x1, Zc, null, group);
      }
    }
  };

  contourPass(strategy.finish, {
    group: 'finish',
    feed: feeds.finish,
    allow: allowFinish,
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
      allow: allowDetail,
      pitch: strategy.detailPitch ?? 1,
      stepover: detailT.stepover ?? 0.5,
      Rt: Math.max((detailT.diameter ?? 1) / 2, 0.05),
    });
  }

  // --------------------------------------------------------------- park
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
  };
}
