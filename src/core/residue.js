/**
 * residue.js — simulated verification of a program: what is LEFT after every
 * block has played, compared with what the design asked for.
 *
 * The static checks in collision.js reason about the tool TIP on rapids. This
 * module reasons about the tool VOLUME on feed moves by actually running the
 * program through the same Simulator + CylindricalStock that playback uses,
 * then diffing the final heightmap against the finished-part skin:
 *
 *     diff[i·nth+j] = r_final − min(target + allow, R0)
 *
 *     diff < −tol  → GOUGE   (the tool broke below the final skin)
 *     diff > +tol  → RESIDUE (rest material the tools never reached)
 *
 * Gouges are attributed to the segment that made them (stock.cutAt's `floor`
 * hook), so they can be painted red in 3D like every other finding.
 *
 * DOM-free: runs in Node tests and in a Web Worker in the browser.
 */
import { CylindricalStock } from '../stock/stock.js';
import { Simulator } from '../app/sim.js';
import { KIND } from './collision.js';

/**
 * Per-cell floor radii on a stock grid: the finished skin `target + allow`,
 * clamped to R0 (material above R0 never existed, so it cannot be residue).
 */
export function buildFloor(design, stock, allow = 0) {
  const { nx, nth, xs, R0 } = stock;
  const floor = new Float32Array(nx * nth);
  const circ = 2 * Math.PI * R0;
  for (let i = 0; i < nx; i++) {
    const v = xs[i];
    for (let j = 0; j < nth; j++) {
      const t = design.targetRadius((j / nth) * circ, v) + allow;
      floor[i * nth + j] = t < R0 ? t : R0;
    }
  }
  return floor;
}

/**
 * Diff a (fully simulated) stock against a floor grid.
 * @returns {{diff:Float32Array, maxGouge:number, maxResidue:number,
 *   gougeCells:number, residueCells:number, meanResidue:number, cells:number,
 *   gougeAt:{i:number,j:number}|null}}
 */
export function residueStats(stock, floor, tol = 0.05, endMargin = 0) {
  const { nx, nth, radii, dx } = stock;
  const n = nx * nth;
  const diff = new Float32Array(n);
  let maxGouge = 0, maxResidue = 0, gougeCells = 0, residueCells = 0, sum = 0;
  let gougeAt = null;
  // Rest material within one tool radius of either end face is not counted:
  // a tool that stops at X = 0 / X = L cannot finish the very end (real parts
  // carry waste there). Gouges are always counted.
  const iSkip = Math.max(0, Math.ceil(endMargin / Math.max(dx, 1e-9)) - 1);
  for (let c = 0; c < n; c++) {
    const d = radii[c] - floor[c];
    diff[c] = d;
    const i = (c / nth) | 0;
    const atEnd = i <= iSkip || i >= nx - 1 - iSkip;
    if (d < -tol) {
      gougeCells++;
      if (-d > maxGouge) { maxGouge = -d; gougeAt = { i: (c / nth) | 0, j: c % nth }; }
    } else if (d > tol && !atEnd) {
      residueCells++;
      sum += d;
      if (d > maxResidue) maxResidue = d;
    }
  }
  return {
    diff, maxGouge, maxResidue, gougeCells, residueCells,
    meanResidue: residueCells ? sum / residueCells : 0, cells: n, gougeAt,
  };
}

/**
 * Simulate a whole program and report gouge / residue against the final skin.
 *
 * @param {{segments:Array}} program
 * @param {object} ctx
 * @param {object} ctx.design      { targetRadius }  (omit when `floor` given)
 * @param {Float32Array} [ctx.floor] precomputed floor grid (worker path)
 * @param {{length:number,R0:number}} ctx.stock
 * @param {{nx:number,nth:number}} ctx.grid
 * @param {object} ctx.tools       { rough, finish, detail } UI descriptors
 * @param {object} ctx.feeds       { rapid, … } (only rapid is used for timing)
 * @param {number} [ctx.allow=0]   final skin above the design (last phase's allowance)
 * @param {number} [ctx.tol=0.05]  mm below the skin that counts as a gouge
 * @param {number} [ctx.endMargin] mm at each end face excluded from the
 *                                 rest-material statistics (default: radius
 *                                 of the largest finishing/detailing tool)
 * @param {number} [ctx.substep]   mm per cut application (Simulator default)
 * @returns residueStats() fields + { nx, nth, findings, summary, ok }
 */
export function analyzeResidue(program, {
  design = null, floor = null, stock: st, grid, tools, feeds = { rapid: 4000 },
  allow = 0, tol = 0.05, substep = undefined, endMargin = undefined,
}) {
  const stock = new CylindricalStock(st.length, st.R0, grid.nx, grid.nth);
  if (!floor) {
    if (!design) throw new Error('analyzeResidue needs a design or a floor grid');
    floor = buildFloor(design, stock, allow);
  }
  const sim = new Simulator(stock, tools, feeds, substep);
  sim.setFloor(floor);
  sim.load(program, null);
  sim.advanceTo(sim.totalDist);

  if (endMargin == null) {
    endMargin = Math.max((tools?.finish?.diameter ?? 4) / 2, (tools?.detail?.diameter ?? 0) / 2);
  }
  const stats = residueStats(stock, floor, tol, endMargin);
  const findings = [];
  const segs = program.segments;
  const gouge = sim.segGouge;
  for (let i = 0; i < segs.length; i++) {
    const g = gouge[i];
    if (g <= tol) continue;
    const s = segs[i];
    findings.push({
      segIdx: i,
      kind: KIND.CUTGOUGE,
      X: s.X, Z: s.Z, A: s.A,
      depth: g,
      group: s.group,
      msg: `${s.group} G1 at X${s.X.toFixed(1)} Z${s.Z.toFixed(1)} cut ${g.toFixed(2)} mm below the final skin`,
    });
  }
  const parts = [];
  if (stats.maxGouge > tol) parts.push(`gouge ${stats.maxGouge.toFixed(2)} mm (${(100 * stats.gougeCells / stats.cells).toFixed(1)}% of surface)`);
  if (stats.maxResidue > tol) parts.push(`rest material up to ${stats.maxResidue.toFixed(2)} mm (${(100 * stats.residueCells / stats.cells).toFixed(1)}%)`);
  return {
    ...stats, nx: grid.nx, nth: grid.nth, tol, findings,
    ok: findings.length === 0,
    summary: parts.join(' · ') || 'on target everywhere',
  };
}
