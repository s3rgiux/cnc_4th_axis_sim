/**
 * offset.js — tool-offset ("drop cutter" / inverse Z-map) surface.
 *
 * A toolpath that puts the tool TIP on the design surface is only correct
 * where the surface normal is radial: on any flank the flute, ball or cone
 * beside the tip bites into the neighbouring material. The classic fix is to
 * plan on the OFFSET surface instead — for every tool position the lowest tip
 * height at which the whole tool volume stays outside `target + allowance`.
 *
 * The offset is evaluated exactly against the stock grid the simulator cuts:
 * for each cell (x_i, φ_j) inside the footprint, with θ = φ_j − A the cell's
 * world angle, T = target(φ_j·R0, x_i) + allow and Δx = x_i − X, the required
 * tip height is the inverse of the corresponding `stock.cutAt` formula:
 *
 *   FLAT   cut iff Zc/cosθ < T and (Zc/cosθ)·|sinθ| ≤ f, f = √(Rt²−Δx²)
 *          → Zc ≥ min(T·cosθ, f·cosθ/|sinθ|)
 *   BALL   centre h = Zc+Rt. Material at T is safe when the ray meets the
 *          sphere at or above T: h ≥ T·cosθ + √(Rt²−Δx²−T²sin²θ) if the
 *          radicand ≥ 0; otherwise the ray must miss the sphere: h ≥ f/|sinθ|.
 *   V-BIT  cone of half-angle α with tip flat Rt: material at T (lateral
 *          d = √(Δx²+T²sin²θ)) is inside iff T·cosθ ≥ Zc and
 *          d ≤ Rt + (T·cosθ−Zc)·tanα  → Zc ≥ T·cosθ − max(0, d−Rt)/tanα
 *
 * tip(X, A) is the maximum of these over the footprint. The search runs
 * outward from the cell under the axis and stops as soon as the analytic
 * bound for the next ring can no longer beat the running maximum, so a Ø4
 * ball costs ~100 cell evaluations per toolpath point.
 *
 * DOM-free.
 */
import { wrap, wrapPi, RAD_PER_DEG } from './unroll.js';

const ABS_LIMIT = 75 * RAD_PER_DEG; // stock.cutAt skips rays beyond this

/**
 * @param {{targetRadius(u,v):number}} design
 * @param {{type?:string, diameter?:number, angle?:number}} tool UI descriptor
 * @param {number} allow  stock to leave above the design (mm)
 * @param {{length:number, R0:number}} stock
 * @param {{nx:number, nth:number}} grid  heightmap resolution (same as stock)
 * @returns {{tipAt(x:number, aDeg:number):number, targetAt(x,aDeg):number,
 *            grid:Float32Array, nx:number, nth:number, tool:object, allow:number}}
 */
export function makeOffsetSurface(design, tool, allow, stock, grid) {
  const { length: L, R0 } = stock;
  const circ = Math.PI * 2 * R0;
  const shape = tool?.type === 'vbit' ? 'vbit' : tool?.type === 'flat' ? 'flat' : 'ball';
  const Rt = Math.max((tool?.diameter ?? 4) / 2, 0.01);
  const Rt2 = Rt * Rt;
  const tanA = shape === 'vbit'
    ? Math.tan(Math.min(Math.max(tool.angle || 90, 15), 170) * 0.5 * RAD_PER_DEG)
    : 0;
  const thetaLimit = shape === 'vbit' ? Math.min(ABS_LIMIT, Math.atan(tanA) * (1 - 1e-6)) : ABS_LIMIT;
  const MARGIN = 0.05; // safety above the heightmap model's cliffs (see req)

  // Sampling grid: the stock grid, supersampled for small tools so the
  // footprint edge (where a ball or flat corner contacts a flank) is resolved
  // to better than Rt/3 instead of a whole stock cell.
  const dx0 = L / (Math.max(8, grid.nx | 0) - 1);
  const ss = shape === 'vbit' ? 2 : Math.min(4, Math.max(1, Math.ceil(dx0 / Math.max(Rt / 3, 0.2))));
  const nx = (Math.max(8, grid.nx | 0) - 1) * ss + 1;
  const nth = Math.max(16, grid.nth | 0) * ss;
  const dx = L / (nx - 1);
  const dTheta = (Math.PI * 2) / nth;
  const cosD = Math.cos(dTheta), sinD = Math.sin(dTheta); // ring-loop rotation step

  // Target + allowance sampled on that grid.
  const T = new Float32Array(nx * nth);
  let Tmax = 0;
  for (let i = 0; i < nx; i++) {
    const v = i * dx;
    for (let j = 0; j < nth; j++) {
      const t = design.targetRadius((j / nth) * circ, v) + allow;
      T[i * nth + j] = t;
      if (t > Tmax) Tmax = t;
    }
  }
  // V-bit axial reach: a cell can constrain only while Tmax − (|Δx|−Rt)/tanα
  // could exceed the running best; the widest that gets is Rt + Tmax·tanα.
  const reachX = shape === 'vbit' ? Rt + Tmax * tanA : Rt;

  // Per-column upper bound of the offset over ALL rotary angles: no tool can
  // be lifted above the highest target inside its axial reach (+ MARGIN).
  // Lets z-level roughing skip the exact evaluation on levels above the
  // local surface, which is most of them.
  const colMax = new Float32Array(nx);
  for (let i = 0; i < nx; i++) {
    let m = 0;
    for (let j = 0; j < nth; j++) if (T[i * nth + j] > m) m = T[i * nth + j];
    colMax[i] = m;
  }
  const reachCells = Math.ceil(reachX / dx) + 1;
  const upperCol = new Float32Array(nx);
  for (let i = 0; i < nx; i++) {
    let m = 0;
    for (let k = Math.max(0, i - reachCells); k <= Math.min(nx - 1, i + reachCells); k++) {
      if (colMax[k] > m) m = colMax[k];
    }
    upperCol[i] = m + 0.06; // MARGIN + rounding slack
  }
  /** Upper bound of tipAt(x, ·) for any A — O(1). */
  function upperAt(x) {
    const i = Math.min(nx - 1, Math.max(0, Math.round(x / dx)));
    return upperCol[i];
  }
  // Lower bound: the offset never drops below the centre target, so the
  // column's minimum target bounds tipAt(x, ·) from below.
  const colMin = new Float32Array(nx);
  for (let i = 0; i < nx; i++) {
    let m = Infinity;
    for (let j = 0; j < nth; j++) if (T[i * nth + j] < m) m = T[i * nth + j];
    colMin[i] = m;
  }
  function lowerAt(x) {
    const i0 = Math.min(nx - 1, Math.max(0, Math.floor(x / dx)));
    const i1 = Math.min(nx - 1, i0 + 1);
    return Math.min(colMin[i0], colMin[i1]);
  }

  // Local angular-window maximum of T per cell. Every ring bound below is
  // "the highest target any cell of this column could have within the angle
  // where it can still matter", so on flat regions the bound collapses to the
  // centre value and the ring loop stops after the first ring. The window is
  // the widest angle at which a cell can still constrain the tool: the cone's
  // flank angle for the V-bit, the footprint/wall-graze limit for the others.
  let Tmin = Infinity;
  for (let c = 0; c < T.length; c++) if (T[c] < Tmin) Tmin = T[c];
  const wideTheta = shape === 'vbit'
    ? thetaLimit
    : Math.asin(Math.min(1, Rt / Math.max(Tmin + Rt - MARGIN, 1e-6)));
  const W = Math.min(nth >> 1, Math.ceil(wideTheta / dTheta) + 2);
  const locMax = new Float32Array(nx * nth);
  {
    // Sliding window max via two passes of a monotone deque would be ideal;
    // rows are short (≤ 1000) and W small, so a direct scan is fine.
    for (let i = 0; i < nx; i++) {
      const row = i * nth;
      for (let j = 0; j < nth; j++) {
        let m = 0;
        for (let d = -W; d <= W; d++) {
          const t = T[row + ((j + d) % nth + nth) % nth];
          if (t > m) m = t;
        }
        locMax[row + j] = m;
      }
    }
  }

  /**
   * Required tip height for one cell (or -Infinity when it cannot be touched).
   *
   * Some branches sit on a CLIFF of the heightmap model: the instant a flat
   * endmill's plane intersection re-enters the footprint, or a ball just
   * grazes a wall column, the whole column above the contact point is deleted
   * (a heightmap cannot hold an overhang). Those branches carry `MARGIN` so a
   * chord within the sampling tolerance can never fall over the edge.
   */
  function req(t, c, s, dxx2) {
    if (shape === 'flat') {
      const f2 = Rt2 - dxx2;
      if (f2 <= 0) return -Infinity;
      const a = t * c;                       // plane meets the ray at T
      const as = Math.abs(s);
      if (as < 1e-9) return a;
      return Math.min(a, (Math.sqrt(f2) * c) / as + MARGIN); // …or exits the footprint
    }
    if (shape === 'ball') {
      const f2 = Rt2 - dxx2;
      if (f2 <= 0) return -Infinity;
      const r1 = f2 - t * t * s * s;
      if (r1 >= 0) return t * c + Math.sqrt(r1) - Rt;   // lower root lands on T
      const as = Math.abs(s);
      return as < 1e-9 ? -Infinity : Math.sqrt(f2) / as - Rt + MARGIN; // ray misses sphere
    }
    // V-bit. Under the tip flat (lateral at the tip plane ≤ Rt) the model cuts
    // the ray straight to Zc, so there the requirement is Zc ≥ T; on the cone
    // flank the point at T must lie on or outside the cone.
    const as = Math.abs(s);
    const d = Math.sqrt(dxx2 + t * t * s * s);
    const over = d - Rt;
    const zCone = t * c - (over > 0 ? over / tanA : 0);
    const f2 = Rt2 - dxx2;
    if (f2 <= 0) return zCone;                          // ray can never pass under the flat
    const zFlat = as < 1e-9 ? Infinity : (Math.sqrt(f2) * c) / as; // tip height where it starts to
    if (zCone > zFlat) return zCone;                    // cone regime
    return Math.min(t, zFlat + MARGIN);                 // flat regime: lift to T or leave the flat
  }

  /**
   * Upper bound on req() for any cell of this column at angle θ whose target
   * is ≤ tmax (the column's local window maximum). Monotone non-increasing in
   * |θ|, which is what lets the ring loop stop early.
   */
  function bound(c, s, dxx2, tmax) {
    if (shape === 'vbit') {
      const dmin = Math.sqrt(dxx2); // lateral ≥ |Δx|
      const over = dmin - Rt;
      // Flat regime can demand up to tmax (no cosθ), cone regime tmax·c − …
      return dxx2 < Rt2 ? tmax + MARGIN : tmax * c - (over > 0 ? over / tanA : 0);
    }
    const f2 = Rt2 - dxx2;
    if (f2 <= 0) return -Infinity;
    const f = Math.sqrt(f2);
    const as = Math.abs(s);
    if (shape === 'flat') return tmax * c;           // min(T·c, …) ≤ T·c
    // ball: branch 1 ≤ T·c + f − Rt; branch 2 = f/|s| − Rt + M with f/|s| < T
    const b1 = tmax * c + f - Rt;
    const b2 = (as < 1e-9 ? tmax : Math.min(f / as, tmax)) - Rt + MARGIN;
    return b1 > b2 ? b1 : b2;
  }

  // Tool-attached samples on the footprint EDGE for the cylindrical tools.
  // Stock cells alone make the floor discontinuous: a wall-top cell that
  // constrains the ball's equator is seen only while it sits inside the
  // footprint and only when its ray is within a fraction of a degree of the
  // tool's axial plane, so the floor becomes a staircase in X and a comb in A.
  // Evaluating the design exactly at points fixed to the tool's rim (and
  // therefore moving continuously with it) restores a continuous floor; the
  // cells stay in the max so the result is still exact against the simulator.
  const EDGE_N = shape === 'vbit' ? 0 : Math.min(48, Math.max(8, Math.ceil((2 * Math.PI * Rt) / dx)));
  const edgeCos = new Float64Array(EDGE_N), edgeSin = new Float64Array(EDGE_N);
  for (let m = 0; m < EDGE_N; m++) {
    const psi = (2 * Math.PI * m) / EDGE_N;
    edgeCos[m] = Math.cos(psi) * Rt * (1 - 1e-6);
    edgeSin[m] = Math.sin(psi) * Rt * (1 - 1e-6);
  }
  /** Max requirement over the rim samples (A in radians, wrapped). */
  function rimMax(x, A, Tc) {
    let best = -Infinity;
    for (let m = 0; m < EDGE_N; m++) {
      const xs = x + edgeCos[m];
      if (xs < 0 || xs > L) continue;
      const y = edgeSin[m];
      // Ray through the rim point: lateral y at the (unknown) radius there;
      // one fixed-point step from the centre radius is ample (Rt ≪ R).
      let th = Math.asin(Math.min(1, Math.abs(y) / Math.max(Tc, 1e-6))) * Math.sign(y);
      const u = wrap(A + th, 2 * Math.PI) * R0;
      const Ts = design.targetRadius(u, xs) + allow;
      th = Math.asin(Math.min(1, Math.abs(y) / Math.max(Ts, 1e-6))) * Math.sign(y);
      const r = req(Ts, Math.cos(th), Math.sin(th), edgeCos[m] * edgeCos[m]);
      if (r > best) best = r;
    }
    return best;
  }

  /**
   * Lowest safe tip height for the tool at axial X, rotary A (deg).
   * Always ≥ the centre target + allowance.
   */
  function tipAt(x, aDeg) {
    const A = wrap(aDeg * RAD_PER_DEG, Math.PI * 2);
    const ic = Math.round(x / dx);
    const jc = Math.round(A / dTheta) % nth;
    // Exact tip-on-centre value: the offset can never be lower than this.
    const Tc = design.targetRadius(A * R0, x) + allow;
    let best = Tc;
    if (EDGE_N) { const r = rimMax(x, A, Tc); if (r > best) best = r; }
    // Columns outward from the one under the tool: 0, +1, −1, +2, −2 …
    for (let k = 0; ; k++) {
      const di = k === 0 ? 0 : (k % 2 ? (k + 1) >> 1 : -(k >> 1));
      const i = ic + di;
      if (Math.abs(di) * dx > reachX + dx) break;
      if (i < 0 || i >= nx) { if (k > 2 * nx) break; continue; }
      const dxx = i * dx - x;
      const dxx2 = dxx * dxx;
      if (shape !== 'vbit' && dxx2 >= Rt2) {
        // Out of the footprint; |Δx| only grows from here.
        if (Math.abs(di) * dx > Rt + dx) break;
        continue;
      }
      const row = i * nth;
      // Column-level prune. With the GLOBAL maximum the θ = 0 bound is
      // monotone in |Δx|, so once it fails no farther column can win: stop.
      // With the column's LOCAL window maximum it is tighter but not
      // monotone across columns, so that one only skips the column.
      // (Columns alternate sides, so |Δx| is not quite monotone in visit
      // order: test the break one cell nearer than this column really is.)
      if (k > 0) {
        const near = Math.max(0, Math.abs(dxx) - dx);
        if (bound(1, 0, near * near, Tmax) <= best) break;
      }
      const tmaxCol = locMax[row + jc];
      if (bound(1, 0, dxx2, tmaxCol) <= best) continue;
      // Rings outward in angle from the cell under the axis. cos/sin of
      // θ0 ± k·dθ come from a rotation recurrence instead of two trig calls
      // per ring (the V-bit visits hundreds of rings per column).
      const theta0 = wrapPi(jc * dTheta - A);
      const c0 = Math.cos(theta0), s0 = Math.sin(theta0);
      let cp = c0, sp = s0, cn = c0, sn = s0; // running (cos, sin) on + and − sides
      for (let m = 0; ; m++) {
        const dj = m === 0 ? 0 : (m % 2 ? (m + 1) >> 1 : -(m >> 1));
        if (Math.abs(dj) > nth >> 1) break;
        const j = ((jc + dj) % nth + nth) % nth;
        let c, s;
        if (m === 0) { c = c0; s = s0; }
        else if (dj > 0) { const t = cp * cosD - sp * sinD; sp = sp * cosD + cp * sinD; cp = t; c = cp; s = sp; }
        else { const t = cn * cosD + sn * sinD; sn = sn * cosD - cn * sinD; cn = t; c = cn; s = sn; }
        const at = Math.abs(theta0 + dj * dTheta);
        if (at > wideTheta) { if (m > 1) break; continue; }
        if (c < 0.01) continue;
        if (m > 2 && bound(c, s, dxx2, tmaxCol) <= best) {
          // Both directions are symmetric in |θ| to within one cell, so once
          // the bound at this ring fails on either side, the next ones will too.
          if (m % 2 === 0) break;
          continue;
        }
        const r = req(T[row + j], c, s, dxx2);
        if (r > best) best = r;
      }
    }
    return best;
  }

  /**
   * Unpruned reference evaluation (every column within reach, every ring
   * within the angular limit). Slow; used by tests as the oracle for tipAt.
   */
  function tipAtBrute(x, aDeg) {
    const A = wrap(aDeg * RAD_PER_DEG, Math.PI * 2);
    const Tc = design.targetRadius(A * R0, x) + allow;
    let best = Tc;
    if (EDGE_N) { const r = rimMax(x, A, Tc); if (r > best) best = r; }
    let arg = null;
    const iLo = Math.max(0, Math.floor((x - reachX) / dx) - 1);
    const iHi = Math.min(nx - 1, Math.ceil((x + reachX) / dx) + 1);
    for (let i = iLo; i <= iHi; i++) {
      const dxx = i * dx - x, dxx2 = dxx * dxx;
      if (shape !== 'vbit' && dxx2 >= Rt2) continue;
      for (let j = 0; j < nth; j++) {
        const theta = wrapPi(j * dTheta - A);
        if (Math.abs(theta) > thetaLimit) continue;
        const c = Math.cos(theta), s = Math.sin(theta);
        if (c < 0.01) continue;
        const r = req(T[i * nth + j], c, s, dxx2);
        if (r > best) { best = r; arg = { i, j, dxx, thetaDeg: theta / RAD_PER_DEG, T: T[i * nth + j] }; }
      }
    }
    tipAtBrute.lastArg = arg;
    return best;
  }

  /** Target + allowance under the tool (no offset) — for diagnostics/ghosts. */
  function targetAt(x, aDeg) {
    const u = wrap(aDeg * RAD_PER_DEG, Math.PI * 2) * R0;
    return design.targetRadius(u, x) + allow;
  }

  return {
    tipAt, tipAtBrute, upperAt, lowerAt, targetAt,
    grid: T, nx, nth, dx, dTheta, tool: { shape, Rt, tanA }, allow,
  };
}
