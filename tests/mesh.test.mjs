/**
 * mesh.test.mjs — STL/OBJ parsing + 3D→cylindrical-heightmap unroll.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSTL, parseOBJ, projectToCylinder, makeHeightmapDesign } from '../src/core/mesh.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function stlBinary(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, t[k], true);
  });
  return buf;
}

/** Tube mesh along a given axis (numeric index 0/1/2) with radius fn r(t,φ). */
function tubeMesh({ length, axis = 1, nt = 41, np = 64, rOf = () => 10 }) {
  const verts = [];
  for (let i = 0; i < nt; i++) {
    const t = i / (nt - 1);
    for (let j = 0; j < np; j++) {
      const phi = (j / np) * TAU;
      const r = rOf(t, phi);
      const p = [0, 0, 0];
      // right-handed cross-plane pair around the axis, matching mesh.js
      const k1 = (axis + 1) % 3, k2 = (axis + 2) % 3;
      p[k1] = r * Math.cos(phi);
      p[k2] = r * Math.sin(phi);
      p[axis] = t * length;
      verts.push(p);
    }
  }
  const tris = [];
  for (let i = 0; i < nt - 1; i++) {
    for (let j = 0; j < np; j++) {
      const j2 = (j + 1) % np;
      const a = verts[i * np + j], b = verts[(i + 1) * np + j], c = verts[(i + 1) * np + j2], d = verts[i * np + j2];
      tris.push([...a, ...b, ...c], [...a, ...c, ...d]);
    }
  }
  const pos = new Float32Array(tris.flat());
  return { pos, count: tris.length };
}

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------
test('parseSTL: binary + ASCII auto-detect', () => {
  const buf = stlBinary([[0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 1, 0, 1, 0, 1, 1]]);
  const b = parseSTL(buf);
  assert.equal(b.count, 2);
  assert.ok(Math.abs(b.pos[3] - 1) < 1e-6);

  const ascii = `solid x
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
facet normal 0 0 1
 outer loop
  vertex 0 0 1
  vertex 1 0 1
  vertex 0 1 1
 endloop
endfacet
endsolid x`;
  const enc = new TextEncoder().encode(ascii);
  const a = parseSTL(enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength));
  assert.equal(a.count, 2);
  assert.ok(Math.abs(a.pos[9 + 2] - 1) < 1e-6);
});

test('parseOBJ: v/f lines, v/vt/vn, quads, negative indices', () => {
  const obj = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
f 1/1/1 2/2/2 3/3/3
f -1/2/3 -2/3/1 -3/1/2 -4/2/1
`;
  const m = parseOBJ(obj);
  assert.equal(m.count, 3); // 1 tri + negative-index quad → 2 tris
  assert.ok(Math.abs(m.pos[0]) < 1e-9);
});

// ---------------------------------------------------------------------------
// cylindrical projection
// ---------------------------------------------------------------------------
test('projectToCylinder: cone → linear turning profile', () => {
  const { pos, count } = tubeMesh({ length: 100, rOf: (t) => 30 - 25 * t });
  const proj = projectToCylinder(pos, count, { length: 200, R0: 25, nx: 101, nth: 72 });
  const d = makeHeightmapDesign(proj, 200, 25, 'cone');
  for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const want = Math.max((30 - 25 * t) * (0.98 * 25 / 30), 0.5);
    const got = d.targetRadius(0, t * 200);
    assert.ok(Math.abs(got - want) < 0.5, `t=${t}: ${got} vs ${want}`);
  }
});

test('projectToCylinder: φ-dependent flat side survives the unroll', () => {
  // r(φ) = 20, but flat at 12 for |φ| < ~53° → on the 2D map the flat
  // sector must read clearly smaller than the round sector. (Assertions are
  // ratio-based: the axis estimate + uniform radial scaling are tested in
  // the cone case, not here.)
  const { pos, count } = tubeMesh({
    length: 80,
    rOf: (_t, phi) => {
      let a = phi;
      if (a > Math.PI) a -= TAU;
      const c = Math.cos(a);
      return c > 0.6 ? Math.min(20, 12 / c) : 20; // flat face at 12, round at 20
    },
  });
  const proj = projectToCylinder(pos, count, { length: 80, R0: 25, nx: 61, nth: 120 });
  const d = makeHeightmapDesign(proj, 80, 25, 'flat');
  const flat = d.targetRadius(0, 40);
  const round = d.targetRadius(Math.PI * 25, 40);
  assert.ok(flat < 0.78 * round, `flat ${flat} vs round ${round}`);
});

test('projectToCylinder: feature crossing the U-seam is seamless', () => {
  const { pos, count } = tubeMesh({
    length: 40,
    rOf: (_t, phi) => {
      let a = phi;
      if (a > Math.PI) a -= TAU;
      return Math.abs(a) < 0.18 ? 20 : 15; // ridge centred at φ = 0 ≡ seam
    },
  });
  const proj = projectToCylinder(pos, count, { length: 40, R0: 25, nx: 41, nth: 120 });
  const d = makeHeightmapDesign(proj, 40, 25, 'seam');
  const C = TAU * 25;
  const atSeam = d.targetRadius(0, 20);
  const justBefore = d.targetRadius(C - 0.5, 20);
  const opposite = d.targetRadius(C / 2, 20);
  // no discontinuity across the seam, and the ridge clearly stands proud
  assert.ok(Math.abs(atSeam - justBefore) < 0.15 * atSeam, `seam ${atSeam} vs ${justBefore}`);
  assert.ok(atSeam > 1.15 * opposite, `ridge ${atSeam} vs ${opposite}`);
  // periodicity of the design function
  assert.ok(Math.abs(d.targetRadius(1.234, 20) - d.targetRadius(1.234 + C, 20)) < 1e-9);
});

test('import pipeline: baroque demo leg STL unrolls with coverage + features', (t) => {
  const f = new URL('../assets/table-leg.stl', import.meta.url).pathname;
  if (!fs.existsSync(f)) { t.skip('run scripts/make-demo-leg.mjs first'); return; }
  const buf = fs.readFileSync(f);
  const tris = parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.ok(tris.count > 20000);
  const proj = projectToCylinder(tris.pos, tris.count, { length: 200, R0: 25, nx: 110, nth: 120 });
  assert.ok(proj.meta.coverage > 0.9);
  assert.equal(proj.meta.axis, 'y');
  const d = makeHeightmapDesign(proj, 200, 25, 'table-leg.stl');
  assert.ok(d.minTarget() > 0.4);
  // volute lobes at φ≈0 and φ≈180 reach almost full stock radius at t≈0.10
  let crest = -1;
  for (let j = 0; j < 120; j++) crest = Math.max(crest, d.targetRadius((j / 120) * TAU * 25, 20));
  assert.ok(crest > 23.5, `crest ${crest}`);
  assert.ok(d.targetRadius(0, 20) > 23.5, 'lobe crest missing at φ=0');
  assert.ok(d.targetRadius(Math.PI * 25, 20) > 23.5, 'lobe crest missing at φ=180');
  assert.ok(d.targetRadius(Math.PI * 25 * 0.5, 20) < 23.2, 'knee waist too high');
  // reeded neck: circumference radius is not constant there
  const row = [];
  for (let j = 0; j < 120; j++) row.push(d.targetRadius((j / 120) * TAU * 25, 98));
  assert.ok(Math.max(...row) - Math.min(...row) > 0.5, 'neck should show reeding');
});
