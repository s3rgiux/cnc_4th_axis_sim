/**
 * adaptive.js — chordal-tolerance sampling of a height function along a
 * straight line in the (X, A) plane.
 *
 * Every strategy moves the tool along straight (X, A) lines (axial sweeps,
 * helix turns, raster lines) with Z following a floor function. A constant
 * angular step both over-samples flats (thousands of collinear blocks) and
 * under-samples beads (visible faceting, gouges between samples). Instead:
 *
 *   1. seed the line with coarse samples,
 *   2. recursively split any interval whose interior probes deviate from the
 *      chord by more than the tolerance, down to `minStep`,
 *   3. greedily merge consecutive samples into the longest chord that stays
 *      within tolerance of every sample it replaces, capped at `maxDX` /
 *      `maxDA` so overlays that draw a block as one straight rotor-space line
 *      stay faithful.
 *
 * The tolerance is ASYMMETRIC: the floor may rise above the chord by at most
 * `tol` (that side is a gouge), but the chord may ride above the floor by
 * `tolAir` (default 4·tol) — a few hundredths of extra skin on a staircase-
 * shaped offset is harmless and lets one block span many tiny bumps.
 *
 * DOM-free.
 */
import { RAD_PER_DEG } from './unroll.js';

/**
 * @param {(x:number, aDeg:number)=>number} zAt  floor height under the tool
 * @param {[number,number]} p0  start [X, A]  (already visited; not emitted)
 * @param {[number,number]} p1  end   [X, A]  (always emitted last)
 * @param {object} o
 * @param {number} [o.tol=0.02]    max floor-above-chord deviation (mm)
 * @param {number} [o.tolAir]      max chord-above-floor deviation (default 4·tol)
 * @param {number} [o.minStep=0.05] smallest interval along the path (mm)
 * @param {number} [o.coarse=2]     seed spacing along the path (mm)
 * @param {number} [o.maxDX=25]     max axial travel per emitted block (mm)
 * @param {number} [o.maxDA=10]     max rotary travel per emitted block (deg)
 * @param {number} [o.R0=25]        radius used to turn ΔA into arc length
 * @returns {Array<[number,number,number]>} [X, A, Z] samples, p0 excluded
 */
export function adaptiveLine(zAt, p0, p1, o = {}) {
  const tol = o.tol ?? 0.02;
  const tolAir = o.tolAir ?? 4 * tol;
  const minStep = o.minStep ?? 0.05;
  /** Signed excess of a floor sample over its chord value, scaled so that
   *  1 = at the limit on either side (gouge side tight, air side loose). */
  const excess = (z, chord) => (z > chord ? (z - chord) / tol : (chord - z) / tolAir);
  const coarse = Math.max(o.coarse ?? 2, minStep);
  const maxDX = o.maxDX ?? 25, maxDA = o.maxDA ?? 10;
  const R0 = o.R0 ?? 25;

  const [x0, a0] = p0, [x1, a1] = p1;
  const dX = x1 - x0, dA = a1 - a0;
  const len = Math.hypot(dX, dA * RAD_PER_DEG * R0);
  if (len < 1e-9) return [];
  const zOf = (t) => zAt(x0 + dX * t, a0 + dA * t);
  const minT = Math.max(minStep / len, 1e-6);

  // ---- 1 + 2: seed and refine -------------------------------------------
  const ts = [0], zs = [zOf(0)];
  function refine(t0, z0, t1, z1) {
    if (t1 - t0 <= minT) {
      // Resolved to the minimum step and still not a straight chord: the
      // floor has a STEP here (a ball beside a near-vertical wall, a flat
      // corner leaving a shoulder). A slanted block across a step puts every
      // intermediate pose below the floor on the high side, so emit an
      // explicit vertical move on the safe side instead: rise before the
      // step, or travel level and drop after it.
      if (Math.abs(z1 - z0) > tol) {
        if (z1 > z0) { ts.push(t0); zs.push(z1); }   // rise at the near end
        else { ts.push(t1); zs.push(z0); }           // hold high, drop at the far end
      }
      return;
    }
    // Interior check. Flat-ish intervals: midpoint + both quarter points (a
    // kink sitting exactly on the midpoint hides from the midpoint alone).
    // STEEP intervals: eight interior points — on a wall the cell-based
    // offset carries narrow bumps (one stock cell wide) that three probes can
    // straddle, and a chord below such a bump gouges. Split at the worst
    // deviation, not the midpoint, so bumps are pinned in one step.
    const steep = Math.abs(z1 - z0) > 4 * tol;
    const K = steep ? 8 : 4;
    let wt = -1, wz = 0, wdev = 1;
    for (let k = 1; k < K; k++) {
      const f = k / K;
      const t = t0 + (t1 - t0) * f;
      const z = zOf(t);
      const dev = excess(z, z0 + (z1 - z0) * f);
      if (dev > wdev) { wdev = dev; wt = t; wz = z; }
    }
    if (wt < 0) return;
    refine(t0, z0, wt, wz);
    ts.push(wt); zs.push(wz);
    refine(wt, wz, t1, z1);
  }
  const n0 = Math.max(1, Math.ceil(len / coarse));
  for (let k = 1; k <= n0; k++) {
    const t = k / n0, z = zOf(t);
    refine(ts[ts.length - 1], zs[zs.length - 1], t, z);
    ts.push(t); zs.push(z);
  }

  // ---- 3: greedy merge ----------------------------------------------------
  const out = [];
  const n = ts.length;
  let i = 0;
  while (i < n - 1) {
    let j = i + 1;
    for (let cand = i + 2; cand < n; cand++) {
      const span = ts[cand] - ts[i];
      if (span <= 0) break; // never merge across a vertical (step) move
      if (Math.abs(span * dX) > maxDX || Math.abs(span * dA) > maxDA) break;
      let ok = true;
      for (let k = i + 1; k < cand; k++) {
        const f = (ts[k] - ts[i]) / span;
        if (excess(zs[k], zs[i] + (zs[cand] - zs[i]) * f) > 1) { ok = false; break; }
      }
      if (!ok) break;
      j = cand;
    }
    out.push([x0 + dX * ts[j], a0 + dA * ts[j], zs[j]]);
    i = j;
  }
  return out;
}
