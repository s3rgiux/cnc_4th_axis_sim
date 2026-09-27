/**
 * stock.js — real-time stock model: a CYLINDRICAL HEIGHTMAP.
 *
 * The raw workpiece is a cylinder about the world X axis, so its surface is
 * exactly described by r(x, φ): a radius per (axial, angular) grid cell. This
 * is the same discretization as the unrolled 2D map — the heightmap IS the
 * unrolled material state, which makes the 2D viewport and the 3D mesh two
 * projections of one buffer. Removal updates scalar radii; the 3D mesh and the
 * 2D heatmap are rebuilt from them (fast: ~13k cells).
 *
 * Cutting geometry (world frame: rotary axis = X, tool axis = vertical Z at
 * world Y = 0, stock rotor rotated by −A so world angle θw = φ − A):
 *
 *   A surface cell at radius ρ is at world (x, −ρ·sin θw, ρ·cos θw), i.e.
 *   lateral distance from the tool axis  d(ρ)  = √((x−Xc)² + ρ²·sin²θw)
 *   height                              z(ρ)  = ρ·cos θw
 *
 * FLAT endmill (tip at Zc, radius Rt, side-cuts along the flute):
 *   material is removed where d ≤ Rt and z ≥ Zc  ⇒  new radius = Zc / cos θw.
 *
 * BALL-nose (sphere radius Rt centred at Zc + Rt, cylindrical above):
 *   material is removed where the ray at angle θw enters the sphere, solved in
 *   closed form:  ρ = (Zc+Rt)·cos θw ± √(Rt² − dx² − (Zc+Rt)²·sin²θw);
 *   the minus root is the cut-down radius. Cells outside the footprint radius
 *   or in overhang cases (cut region exits the footprint) are conservatively
 *   left alone; cells beyond ±75° from top-dead-centre are skipped (the tool
 *   physically cannot reach there).
 *
 * V-BIT (truncated cone, tip flat radius Rt, half-angle α = angle/2, apex h0 =
 *   Rt/tan α below the tip plane): a point at radius ρ is inside the tool when
 *   √(dx² + ρ²s²) ≤ (ρ·c − Zc + h0)·tan α with ρ·c ≥ Zc − h0. The cut-down
 *   radius is the largest root of the resulting quadratic (the smaller root is
 *   the phantom nappe below the apex and is rejected); cells whose ray meets
 *   the tip flat within Rt are cut straight to Zc. Rays steeper than the flank
 *   (θw ≥ α) find no valid root and are skipped — the flank never reaches them.
 *
 * DOM-free: safe to import from Node tests.
 */
import { wrap, wrapPi, RAD_PER_DEG } from '../core/unroll.js';

export class CylindricalStock {
  /**
   * @param {number} length workpiece length (mm), spanning x ∈ [0, length]
   * @param {number} R0     raw stock radius (mm)
   * @param {number} nx     axial grid resolution
   * @param {number} nth    angular grid resolution (circumference)
   */
  constructor(length, R0, nx = 110, nth = 120) {
    this.resize(length, R0, nx, nth);
  }

  resize(length, R0, nx = this.nx, nth = this.nth) {
    this.length = length;
    this.R0 = R0;
    this.nx = Math.max(8, nx | 0);
    this.nth = Math.max(16, nth | 0);
    this.dx = length / (this.nx - 1);
    this.dTheta = (Math.PI * 2) / this.nth;
    this.xs = new Float32Array(this.nx);
    for (let i = 0; i < this.nx; i++) this.xs[i] = i * this.dx;
    this.radii = new Float32Array(this.nx * this.nth);
    this.reset();
  }

  reset() {
    this.version = (this.version || 0) + 1; // mesh-dirty generation counter
    this.radii.fill(this.R0);
    this.removedMm3 = 0;
  }

  get removedCm3() {
    return this.removedMm3 / 1000;
  }

  idx(i, j) {
    return i * this.nth + j;
  }

  /** Radius of the cell containing axial position x and angle index j. */
  radiusAt(i, j) {
    return this.radii[i * this.nth + j];
  }

  /**
   * Apply one tool pose: sweep the cutter footprint over the grid and lower
   * any radius that lies inside the tool volume. Monotonic — radii only
   * decrease, so repeated/overlapping poses are idempotent.
   *
   * @param {number} xc   tool X (mm)
   * @param {number} zc   tool tip distance from rotation axis (mm)
   * @param {number} aDeg rotary angle A (degrees, continuous)
   * @param {{R:number, shape?:'flat'|'ball'|'vbit', angle?:number, ball?:boolean}} tool
   *   shape wins; `ball` boolean is accepted as a legacy alias. `angle` is the
   *   V-bit included angle (deg), R its tip-flat radius.
   * @returns {boolean} true if any material was removed
   */
  cutAt(xc, zc, aDeg, tool) {
    const Rt = Math.max(tool.R, 0.01);
    const shape = tool.shape || (tool.ball ? 'ball' : 'flat');
    const zcEff = Math.max(zc, 0);
    const A = aDeg * RAD_PER_DEG;
    const { nth, nx, dx, dTheta, xs, radii, R0 } = this;

    // Lateral window of influence: Rt for the cylindrical tools; a V-bit cone
    // widens with depth, so its reach grows with the deepest possible bite
    // (a cell at radius ≤ R0 can be cut out to Rt + (R0 − Zc)·tan α).
    let reach = Rt;
    let tanA = 0, h0 = 0;
    if (shape === 'vbit') {
      const alpha = Math.min(Math.max(tool.angle || 90, 15), 170) * 0.5 * RAD_PER_DEG;
      tanA = Math.tan(alpha);
      h0 = Rt / tanA; // apex sits h0 below the tip plane
      reach = Rt + Math.max(0, R0 - zcEff) * tanA;
    }
    const reach2 = reach * reach;
    const foot2 = Rt * Rt; // footprint limit for the cylindrical tools

    // Axial window of influence: |x − xc| ≤ reach.
    let i0 = Math.floor((xc - reach - xs[0]) / dx);
    let i1 = Math.ceil((xc + reach - xs[0]) / dx);
    i0 = Math.max(0, i0);
    i1 = Math.min(nx - 1, i1);
    if (i0 > i1) return false;

    let removed = false;
    const cellAngleVol = 0.5 * dTheta * dx; // ΔV = ½(r²−r'²)·Δθ·Δx
    const absLimit = 75 * RAD_PER_DEG;

    for (let i = i0; i <= i1; i++) {
      const dxx = xs[i] - xc;
      const dxx2 = dxx * dxx;
      if (dxx2 > reach2) continue;
      const ringFoot2 = foot2 - dxx2; // max (ρ·sin θw)² inside footprint
      const rowBase = i * nth;

      for (let j = 0; j < nth; j++) {
        const thetaW = wrapPi((j * dTheta) - A); // world angle of this cell
        if (Math.abs(thetaW) > absLimit) continue;
        const c = Math.cos(thetaW);
        const s = Math.sin(thetaW);
        if (c < 0.01) continue; // grazing — treat as unreachable
        const s2 = s * s;

        const r0 = radii[rowBase + j];
        let rNew;
        if (shape === 'flat') {
          // FLAT: cut down to tip-height plane inside the footprint.
          const rhoCut = zcEff / c;
          if (rhoCut >= r0) continue;
          // Footprint limit along this ray: ρ²s² ≤ ringFoot2.
          if (s2 > 1e-9) {
            const rhoMax = Math.sqrt(ringFoot2 / s2);
            if (rhoCut > rhoMax) continue; // overhang case: conservative skip
          }
          rNew = rhoCut;
        } else if (shape === 'ball') {
          // BALL: sphere intersection along the ray.
          const h = zcEff + Rt;
          const disc = foot2 - dxx2 - h * h * s2;
          if (disc <= 0) continue;
          rNew = h * c - Math.sqrt(disc);
          if (rNew >= r0 || rNew < 0) continue;
          if (s2 > 1e-9) {
            const rhoMax = Math.sqrt(ringFoot2 / s2);
            if (rNew > rhoMax) continue; // overhang case: conservative skip
          }
        } else {
          // V-BIT: tip flat first, then the cone flank.
          const t2 = tanA * tanA;
          const tanW = s / c;
          if (tanW * tanW >= t2 * (1 - 1e-9)) continue; // ray steeper than flank
          const dt2 = dxx2 + zcEff * zcEff * tanW * tanW; // lateral at tip plane
          if (dt2 <= foot2) {
            rNew = zcEff; // under the tip flat
          } else {
            // Largest root of ρ²(s²−t²c²) − 2t²ck·ρ + (dx²−t²k²) = 0,
            // k = h0 − Zc (quadratic of d(ρ) = (ρc − Zc + h0)·tan α).
            const k = h0 - zcEff;
            const qa = s2 - t2 * c * c;
            const qb = -2 * t2 * c * k;
            const qc = dxx2 - t2 * k * k;
            if (Math.abs(qa) < 1e-12) {
              if (Math.abs(qb) < 1e-12) continue;
              rNew = -qc / qb;
            } else {
              const disc = qb * qb - 4 * qa * qc;
              if (disc < 0) continue;
              const sq = Math.sqrt(disc);
              rNew = Math.max((-qb + sq) / (2 * qa), (-qb - sq) / (2 * qa));
            }
            if (!(rNew >= zcEff) || rNew * c + k < 0) continue; // phantom root
          }
          if (rNew >= r0) continue;
        }

        radii[rowBase + j] = rNew;
        this.removedMm3 += (r0 * r0 - rNew * rNew) * cellAngleVol;
        removed = true;
      }
    }
    if (removed) this.version++;
    return removed;
  }

  // -------------------------------------------------------------------------
  // Meshing. The rotor-local surface point of cell (i, j) is
  // P = (x_i, −r·sin φ_j, r·cos φ_j) with φ_j = 2π j/nth.
  // Grid is wrapped in j (seamless); open ends (chucks cover them).
  // -------------------------------------------------------------------------

  /** Vertex count of the produced mesh. */
  meshVertexCount() {
    return this.nx * this.nth;
  }

  meshIndexCount() {
    return (this.nx - 1) * (this.nth) * 6;
  }

  /**
   * Rebuild position and (analytic finite-difference) normal arrays from the
   * current radii.
   * @param {Float32Array} pos    length nx*nth*3
   * @param {Float32Array} nrm    length nx*nth*3
   */
  buildMesh(pos, nrm) {
    const { nx, nth, dx, dTheta, xs, radii } = this;
    // Positions first.
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nth; j++) {
        const r = radii[i * nth + j];
        const phi = j * dTheta;
        const k = (i * nth + j) * 3;
        pos[k] = xs[i];
        pos[k + 1] = -r * Math.sin(phi);
        pos[k + 2] = r * Math.cos(phi);
      }
    }
    // Normals: cross of central-difference tangents (wraps in φ).
    const v = [0, 0, 0], tx = [0, 0, 0], tp = [0, 0, 0];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nth; j++) {
        const k = (i * nth + j) * 3;
        const jm = (j - 1 + nth) % nth;
        const jp = (j + 1) % nth;
        const km = (i * nth + jm) * 3;
        const kp = (i * nth + jp) * 3;
        const im = Math.max(i - 1, 0) * nth * 3 + j * 3;
        const ip = Math.min(i + 1, nx - 1) * nth * 3 + j * 3;
        // Tangent along X
        tx[0] = pos[ip] - pos[im];
        tx[1] = pos[ip + 1] - pos[im + 1];
        tx[2] = pos[ip + 2] - pos[im + 2];
        // Tangent along φ
        tp[0] = pos[kp] - pos[km];
        tp[1] = pos[kp + 1] - pos[km + 1];
        tp[2] = pos[kp + 2] - pos[km + 2];
        v[0] = tx[1] * tp[2] - tx[2] * tp[1];
        v[1] = tx[2] * tp[0] - tx[0] * tp[2];
        v[2] = tx[0] * tp[1] - tx[1] * tp[0];
        const len = Math.hypot(v[0], v[1], v[2]) || 1;
        // Outward check: normal should point away from the axis (positive dot
        // with the radial direction at this cell).
        const radx = 0, rady = pos[k + 1], radz = pos[k + 2];
        const sign = v[0] * radx + v[1] * rady + v[2] * radz >= 0 ? 1 : -1;
        nrm[k] = (sign * v[0]) / len;
        nrm[k + 1] = (sign * v[1]) / len;
        nrm[k + 2] = (sign * v[2]) / len;
      }
    }
  }

  /** Triangle indices for an nx × nth wrapped grid (built once per resize). */
  buildIndices() {
    const { nx, nth } = this;
    const idx = new Uint32Array((nx - 1) * nth * 6);
    let o = 0;
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < nth; j++) {
        const jn = (j + 1) % nth;
        const a = i * nth + j;
        const b = i * nth + jn;
        const c = (i + 1) * nth + j;
        const d = (i + 1) * nth + jn;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    return idx;
  }
}
