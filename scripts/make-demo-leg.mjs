/**
 * scripts/make-demo-leg.mjs — procedurally generates a "complex surface"
 * baroque turned table leg and writes it as a real binary STL asset:
 *
 *     node scripts/make-demo-leg.mjs   →   assets/table-leg.stl
 *
 * Surface features (all φ-dependent, so the unrolled 2D map gets interesting):
 *   · cabriole knee + long taper (axisymmetric turning profile)
 *   · twin volute/scroll lobes under the head
 *   · 5 spiralling acanthus leaf ridges down the taper
 *   · reeded (fluted) narrow neck
 *   · diamond quarry-cut facet panels (8 panels × 4 rows)
 *   · three-lobed claw ball foot
 *
 * The app imports this file through exactly the same pipeline as any user
 * STL — this script only exists so the asset is licence-free + reproducible.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { makeProfileInterpolator } from '../src/core/profiles.js';

const TAU = Math.PI * 2;
const L = 200;      // leg length (mm) — matches default stock
const RMAX = 24.6;  // stay inside default R0 = 25
const NT = 121;     // stations along the axis
const NP = 96;      // angular segments

// --- axisymmetric turning profile ------------------------------------------
const profile = makeProfileInterpolator([
  [0, 16], [0.02, 17.5], [0.06, 20], [0.13, 23.8], [0.19, 22], [0.30, 14],
  [0.40, 8.5], [0.46, 7], [0.52, 10.5], [0.58, 19], [0.63, 16.5], [0.70, 7.5],
  [0.73, 10.5], [0.76, 10.8], [0.79, 7], [0.84, 9.5], [0.90, 14.5],
  [0.945, 15.5], [0.985, 9.5], [1, 8.5],
]);

const bell = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)));
const angDist = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
};

/** Full surface radius of the leg at axial fraction t, angle φ (mm). */
function radius(t, phi) {
  let r = profile(t);
  // twin volute scrolls under the head
  const vs = bell(t, 0.03, 0.16);
  if (vs > 0) {
    r += 2.6 * vs * (Math.exp(-Math.pow(angDist(phi, 0) / 0.55, 2)) +
                     Math.exp(-Math.pow(angDist(phi, Math.PI) / 0.55, 2)));
  }
  // five spiralling acanthus leaf ridges
  const ac = bell(t, 0.15, 0.45);
  if (ac > 0) {
    const s = Math.max(0, Math.sin(5 * phi - 12 * t));
    r += 3.4 * ac * s * s * (0.6 + 0.4 * Math.sin(30 * t + 5 * phi));
  }
  // reeded neck
  if (t > 0.455 && t < 0.525) r -= 1.1 * Math.pow(Math.max(0, Math.sin(12 * phi)), 2);
  // diamond quarry-cut panels
  if (t > 0.545 && t < 0.695) {
    const fq = Math.abs((((phi / TAU) * 8 + 0.5) % 1) - 0.5) * 2;
    const ft = Math.abs(((((t - 0.545) / 0.15) * 4 + 0.5) % 1) - 0.5) * 2;
    r -= 1.6 * Math.max(0, 1 - (fq * fq + ft * ft) * 1.8);
  }
  // three-lobed ball foot
  const lb = bell(t, 0.8, 1.0);
  if (lb > 0) r += 0.9 * lb * Math.cos(3 * phi);
  // claw tips at the very bottom
  if (t > 0.955) {
    const claw = Math.pow(Math.max(0, Math.cos(3 * phi)), 4);
    r += (1.8 * claw - 0.6 * (1 - claw)) * Math.min(1, (t - 0.955) / 0.02);
  }
  return Math.max(1.2, Math.min(RMAX, r));
}

// --- vertex grid -------------------------------------------------------------
// Parameterisation is right-handed around +Y (the model axis) so it matches
// projectToCylinder's φ = atan2(dx, dz) convention exactly: a point at angle φ
// sits at x = r·sin φ, z = r·cos φ (rotating +Z toward +X).
const vx = new Float64Array(NT * NP * 3);
for (let i = 0; i < NT; i++) {
  const t = i / (NT - 1);
  for (let j = 0; j < NP; j++) {
    const phi = (j / NP) * TAU;
    const r = radius(t, phi);
    const o = (i * NP + j) * 3;
    vx[o] = r * Math.sin(phi);
    vx[o + 1] = t * L;
    vx[o + 2] = r * Math.cos(phi);
  }
}
// cap apexes
const apexTop = NT * NP;
const apexBot = NT * NP + 1;
const vertex = (a, out) => {
  if (a === apexTop) { out[0] = 0; out[1] = 0; out[2] = 0; }
  else if (a === apexBot) { out[0] = 0; out[1] = L; out[2] = 0; }
  else { out[0] = vx[a * 3]; out[1] = vx[a * 3 + 1]; out[2] = vx[a * 3 + 2]; }
};

// --- triangles with outward winding -------------------------------------------
const tris = [];
const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
function emit(a, b, c, hint) {
  vertex(a, A); vertex(b, B); vertex(c, C);
  const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
  const wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  // side faces: test against the radial direction of the centroid; caps: ±axis
  const dot = hint
    ? nx * hint[0] + ny * hint[1] + nz * hint[2]
    : nx * (A[0] + B[0] + C[0]) / 3 + nz * (A[2] + B[2] + C[2]) / 3;
  if (dot < 0) tris.push(A[0], A[1], A[2], C[0], C[1], C[2], B[0], B[1], B[2]);
  else tris.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
}
for (let i = 0; i < NT - 1; i++) {
  for (let j = 0; j < NP; j++) {
    const j2 = (j + 1) % NP;
    emit(i * NP + j, (i + 1) * NP + j, (i + 1) * NP + j2);
    emit(i * NP + j, (i + 1) * NP + j2, i * NP + j2);
  }
}
for (let j = 0; j < NP; j++) {
  const j2 = (j + 1) % NP;
  emit(apexTop, j, j2, [0, -1, 0]);                                   // top cap
  emit(apexBot, (NT - 1) * NP + j2, (NT - 1) * NP + j, [0, 1, 0]);    // bottom cap
}

// --- binary STL writer ---------------------------------------------------------
const n = tris.length / 9;
const buf = new ArrayBuffer(84 + n * 50);
const dv = new DataView(buf);
const hdr = 'baroque table leg - procedural demo for the 4-axis rotary simulator'.padEnd(80, '\0');
for (let i = 0; i < 80; i++) dv.setUint8(i, hdr.charCodeAt(i) & 0x7f);
dv.setUint32(80, n, true);
for (let t = 0; t < n; t++) {
  const o = 84 + t * 50;
  const ax = tris[t * 9], ay = tris[t * 9 + 1], az = tris[t * 9 + 2];
  const ux = tris[t * 9 + 3] - ax, uy = tris[t * 9 + 4] - ay, uz = tris[t * 9 + 5] - az;
  const wx = tris[t * 9 + 6] - ax, wy = tris[t * 9 + 7] - ay, wz = tris[t * 9 + 8] - az;
  let fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
  const fl = Math.hypot(fx, fy, fz) || 1;
  dv.setFloat32(o, fx / fl, true);
  dv.setFloat32(o + 4, fy / fl, true);
  dv.setFloat32(o + 8, fz / fl, true);
  for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, tris[t * 9 + k], true);
  dv.setUint16(o + 48, 0, true);
}

const out = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'table-leg.stl'), Buffer.from(buf));
console.log(`assets/table-leg.stl — ${n} triangles, ${buf.byteLength} bytes`);
