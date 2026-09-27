/**
 * unroll.js — the mathematical heart of the simulator.
 *
 * A 4th-axis rotary machine is a cylinder unrolled into a plane and back:
 *
 *   UNROLL  (3D surface → 2D map):
 *       U = θ · R      rotational / circumferential position (arc-length mm)
 *       V = Z_world    axial length position along the workpiece
 *
 *   REMAP   (2D map → synchronized 4th-axis machine coordinates):
 *       A = (U / R) · 180/π   rotary table angle (degrees, continuous, no wrap)
 *       X = V                 longitudinal position along the workpiece
 *       Z = R − depth         tool-tip distance from the rotation axis
 *
 * Coordinate conventions used everywhere in this code base
 * --------------------------------------------------------
 * - World frame: right-handed, Z up. The rotary axis (A) is the world X axis.
 * - The spindle tool axis is vertical (world Z); its tool axis line passes
 *   through world Y = 0. The tool tip at machine pose (X, Z) sits at
 *   world (X, 0, Z), so Z is exactly "distance from the rotation axis".
 * - The workpiece lives in a rotor group rotated by −A about world X. A stock
 *   surface cell with stock-local angle φ is therefore at world angle θw = φ − A.
 *   The tool (at world angle 0, top-dead-centre) engages the material cell
 *   whose φ equals A — so the point on the design map being cut is
 *   U_contact = wrap(A·π/180) · R0, and increasing A travels +U on the map.
 */

export const DEG_PER_RAD = 180 / Math.PI;
export const RAD_PER_DEG = Math.PI / 180;

/** Positive modulo (always in [0, m)). */
export function wrap(v, m) {
  const w = v % m;
  return w < 0 ? w + m : w;
}

/** Wrap an angle (rad) into (−π, π]. */
export function wrapPi(a) {
  return wrap(a + Math.PI, Math.PI * 2) - Math.PI;
}

export function circumference(radius) {
  return 2 * Math.PI * radius;
}

/**
 * Map a point of the flattened 2D design map to synchronized 4th-axis
 * machine coordinates (the spec blueprint, kept verbatim in signature).
 *
 * @param {number} u        circumferential position on the unrolled map (mm arc)
 * @param {number} v        axial position along the workpiece (mm)
 * @param {number} depth    depth of cut below the surface used for unrolling (mm)
 * @param {number} r        radius used for the unroll (usually raw stock R0) (mm)
 * @returns {{X:number, Z:number, A:number}} machine coordinates
 */
export function map2DTo4Axis(u, v, depth, r) {
  const angleRad = u / r;
  const angleDeg = angleRad * DEG_PER_RAD; // A-Axis
  const xPos = v;                          // X-Axis
  const zPos = r - depth;                  // Z-Axis
  return { X: xPos, Z: zPos, A: angleDeg };
}

/**
 * Inverse of map2DTo4Axis. A is accepted in degrees (continuous values wrap
 * onto the map). Returns the depth below the unroll radius as well.
 */
export function map4AxisTo2D(x, z, aDeg, r) {
  return {
    U: wrap(aDeg * RAD_PER_DEG * r, circumference(r)),
    V: x,
    depth: r - z,
  };
}

/**
 * The U coordinate of the design map currently under the tool for a given
 * rotary angle A (degrees). Normalized at the raw stock radius R0 so the map
 * has a stable width of 2πR0 regardless of the cut radius.
 */
export function uFromA(aDeg, R0) {
  return wrap(aDeg * RAD_PER_DEG, Math.PI * 2) * R0;
}

/** Rotary angle (deg) that places map position U under the tool. */
export function aFromU(u, R0) {
  return (u / R0) * DEG_PER_RAD;
}

/**
 * Stock-local world position of a surface point (before the rotor A rotation
 * is applied). φ is the stock-local angle from top-dead-centre.
 * P = (x, −r·sin φ, r·cos φ); φ = 0 is the point the tool touches at A = 0.
 */
export function surfacePoint(x, r, phiRad, out = [0, 0, 0]) {
  out[0] = x;
  out[1] = -r * Math.sin(phiRad);
  out[2] = r * Math.cos(phiRad);
  return out;
}

/**
 * Position of the tool-tip contact point expressed in stock-local rotor space.
 * Used to draw the toolpath as it is inscribed on the rotating workpiece:
 * the world tip (X, 0, Z) maps to local radius Z at stock angle φ = A.
 */
export function tipToRotor(x, z, aDeg, out = [0, 0, 0]) {
  const a = aDeg * RAD_PER_DEG;
  out[0] = x;
  out[1] = -z * Math.sin(a);
  out[2] = z * Math.cos(a);
  return out;
}

/**
 * Approximate machine-space distance for feed-rate timing of one move.
 * Linear axes contribute Euclidean distance; the rotary axis contributes its
 * arc length at the current cutting radius (Z ≈ cutting radius here).
 */
export function moveDistance(x0, z0, a0, x1, z1, a1) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const rArc = Math.max((z0 + z1) * 0.5, 0);
  const dArc = (a1 - a0) * RAD_PER_DEG * rArc;
  return Math.sqrt(dx * dx + dz * dz + dArc * dArc);
}
