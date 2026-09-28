/**
 * collision.js — static, advisory collision checks on a generated program.
 *
 * These checks run ONCE at load time (no playback state involved) and never
 * alter the program or the simulation — they surface genuine programming
 * bugs the planner or a hand-edit may have introduced:
 *
 * 1. RAPIDS GOUGE — a G0 whose tip breaks below the finished-part surface
 *    (`design.targetRadius`) can never be legitimate: it ploughs into the
 *    part that the finishing pass just made.
 * 2. RAPIDS IN ENVELOPE — a G0 that travels along X while below the raw-stock
 *    clearance height (R0 + clearance) only clears if earlier cuts already
 *    removed the material on its path. Pure radial retracts (ΔX ≈ 0) are the
 *    normal way out of a groove and are NOT flagged. The generator keeps every
 *    axial rapid at Zc, so a flag here means a real risk.
 * 3. OVERTRAVEL — X/Z outside the machine travel limits. A is deliberately
 *    unbounded: continuous multi-turn A is the machine's headline feature.
 * 4. MACHINE ENVELOPE — an AABB (carriage post, head, chuck…) vs the swept
 *    stock cylinder over x∈[0,L]; the pure core of the M1 acceptance test,
 *    shared by the Node tests and the browser smoke test.
 *
 * The tool is treated as its tip point: side-cutting by the flute body during
 * a rapid is beyond this static model (and already prevented by clearances).
 *
 * DOM-free: safe to import from Node tests.
 */
import { uFromA, moveDistance } from './unroll.js';

export const KIND = {
  GOUGE: 'gouge',           // rapid below the finished surface
  ENVELOPE: 'envelope',     // axial rapid below raw-stock clearance height
  OVERTRAVEL: 'overtravel', // axis beyond machine limits
  CUTGOUGE: 'cutgouge',     // feed move whose tool VOLUME cut below the final skin
};

/** Severity for "worst finding per segment" (higher = worse). */
const SEVERITY = { [KIND.GOUGE]: 2, [KIND.ENVELOPE]: 1, [KIND.OVERTRAVEL]: 0 };

// ---------------------------------------------------------------------------
// 4. AABB vs swept stock cylinder (M1 detector, single source of truth)
// ---------------------------------------------------------------------------

/**
 * Does an axis-aligned box intersect the cylinder of radius R about the world
 * X axis spanning x ∈ [0, L]? The rotary axis is the line y=0, z=0, so the
 * box's signed gaps from the axis combine in quadrature.
 *
 * @param {[number,number,number,number,number,number]} aabb [x0,x1,y0,y1,z0,z1]
 * @param {number} L    stock length (axial span of the swept circle)
 * @param {number} R    swept radius (raw stock R0)
 * @param {number} tol  contact tolerance (mm)
 */
export function aabbVsSweptCylinder(aabb, L, R, tol = 0.05) {
  const [x0, x1, y0, y1, z0, z1] = aabb;
  if (!(x1 > -tol && x0 < L + tol)) return false; // box axially clear of the work
  const dy = y0 > 0 ? y0 : (y1 < 0 ? -y1 : 0);
  const dz = z0 > 0 ? z0 : (z1 < 0 ? -z1 : 0);
  return Math.hypot(dy, dz) < R - tol;
}

/**
 * Test named machine members against the swept stock.
 * @param {Array<{name:string, aabb:Array}>} frames
 */
export function machineEnvelopeCheck(frames, L, R, tol = 0.05) {
  const findings = [];
  for (const f of frames) {
    if (aabbVsSweptCylinder(f.aabb, L, R, tol)) {
      findings.push({
        kind: 'machine',
        name: f.name,
        msg: `${f.name} intersects the swept stock envelope (L=${L}, R=${R})`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 1 + 2. Rapid-move gouge / envelope checks
// ---------------------------------------------------------------------------

/**
 * Flag G0 segments that run the risk of ploughing into material.
 *
 * @param {Array} segments program segments {mode,X,Z,A,F,group}
 * @param {object} ctx { R0, length, clearance, design } — design optional;
 *   without it only the raw-stock envelope check runs.
 * @returns {Array} findings {segIdx, kind, X, Z, A, limit, msg}
 */
export function rapidsGougeCheck(segments, { R0, length, clearance, design = null, tol = 1e-6 }) {
  const findings = [];
  if (!segments || segments.length < 2) return findings;
  const Zc = R0 + clearance;
  // The program starts AT its first block (sim.home() convention).
  let prev = segments[0];
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i];
    if (s.mode === 'G0') {
      const hit = checkRapid(prev, s, { R0, length, Zc, design, tol });
      if (hit) findings.push({ segIdx: i, ...hit });
    }
    prev = s;
  }
  return findings;
}

/** Sample one G0 move; return the worst hit (or null). */
function checkRapid(prev, s, { R0, length, Zc, design, tol }) {
  const len = moveDistance(prev.X, prev.Z, prev.A, s.X, s.Z, s.A);
  const n = Math.max(2, Math.ceil(len / 2)); // ~2 mm sampling
  const axial = Math.abs(s.X - prev.X) > 0.05;
  let worst = null;
  const consider = (kind, X, Z, A, limit) => {
    if (worst && SEVERITY[kind] <= SEVERITY[worst.kind]) return;
    worst = { kind, X, Z, A, limit };
  };
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const X = prev.X + (s.X - prev.X) * t;
    const Z = prev.Z + (s.Z - prev.Z) * t;
    const A = prev.A + (s.A - prev.A) * t;
    if (X < -tol || X > length + tol) continue; // beyond the work: no material
    if (design) {
      const rT = design.targetRadius(uFromA(A, R0), X);
      if (Z < rT - tol) {
        consider(KIND.GOUGE, X, Z, A, rT);
        break; // can't get worse than chewing the finished part
      }
    }
    if (axial && Z < Zc - tol) consider(KIND.ENVELOPE, X, Z, A, Zc);
  }
  if (!worst) return null;
  const msg = worst.kind === KIND.GOUGE
    ? `G0 at X${worst.X.toFixed(1)} Z${worst.Z.toFixed(1)} breaks below the finished surface (r=${worst.limit.toFixed(1)})`
    : `G0 at X${worst.X.toFixed(1)} Z${worst.Z.toFixed(1)} travels inside raw stock (Z < ${worst.limit.toFixed(1)})`;
  return { ...worst, msg };
}

// ---------------------------------------------------------------------------
// 3. Overtravel
// ---------------------------------------------------------------------------

/**
 * @param {Array} segments
 * @param {{xMin,xMax,zMin,zMax}} limits machine travel (mm)
 */
export function overtravelCheck(segments, limits) {
  const findings = [];
  if (!segments || !limits) return findings;
  const { xMin, xMax, zMin, zMax } = limits;
  const axisHit = (segIdx, s, axis, value, lo, hi) => {
    if (value >= lo && value <= hi) return;
    const limit = value < lo ? lo : hi;
    findings.push({
      segIdx,
      kind: KIND.OVERTRAVEL,
      axis,
      value,
      limit,
      // real segment pose so the 3D overlay can mark where it happened
      X: s.X, Z: s.Z, A: s.A,
      msg: `${axis}${value.toFixed(1)} exceeds travel ${axis}${limit.toFixed(1)}`,
    });
  };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    axisHit(i, s, 'X', s.X, xMin, xMax);
    axisHit(i, s, 'Z', s.Z, zMin, zMax);
    // A is intentionally unchecked: continuous rotary (A24000.0) is a feature.
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Program-level analysis
// ---------------------------------------------------------------------------

/**
 * Run every static check over a program.
 *
 * @param {{segments:Array}} program
 * @param {object} ctx { design, stock:{length,R0}, clearance, limits }
 * @returns {{findings:Array, counts:object, ok:boolean, summary:string}}
 */
export function analyzeProgram(program, { design = null, stock, clearance, limits = null }) {
  const findings = [];
  findings.push(...rapidsGougeCheck(program.segments, {
    R0: stock.R0, length: stock.length, clearance, design,
  }));
  findings.push(...overtravelCheck(program.segments, limits));
  findings.sort((a, b) => a.segIdx - b.segIdx);

  return summarize(findings);
}

/** Counts + human summary for a sorted findings list. */
export function summarize(findings) {
  const counts = { gouge: 0, envelope: 0, overtravel: 0, cutgouge: 0 };
  let deepest = 0;
  for (const f of findings) {
    counts[f.kind] = (counts[f.kind] || 0) + 1;
    if (f.kind === KIND.CUTGOUGE && f.depth > deepest) deepest = f.depth;
  }
  const parts = [];
  if (counts.gouge) parts.push(`${counts.gouge} rapid gouge${counts.gouge > 1 ? 's' : ''} below finished surface`);
  if (counts.envelope) parts.push(`${counts.envelope} axial rapid${counts.envelope > 1 ? 's' : ''} inside stock envelope`);
  if (counts.overtravel) parts.push(`${counts.overtravel} overtravel block${counts.overtravel > 1 ? 's' : ''}`);
  if (counts.cutgouge) parts.push(`${counts.cutgouge} feed block${counts.cutgouge > 1 ? 's' : ''} cut below the final skin (max ${deepest.toFixed(2)} mm)`);
  return {
    findings,
    counts,
    ok: findings.length === 0,
    summary: parts.join(' · '),
  };
}

/**
 * Merge the static analysis with the simulated residue analysis (which runs
 * later, off the main thread in the browser) into one advisory result.
 */
export function mergeAnalyses(staticAnalysis, residueFindings) {
  const findings = [...staticAnalysis.findings, ...(residueFindings || [])];
  findings.sort((a, b) => a.segIdx - b.segIdx);
  return summarize(findings);
}