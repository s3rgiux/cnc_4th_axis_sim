/**
 * Unit tests for the DOM-free core: unroll math, designs, toolpath strategies,
 * G-code post-processor, and the cylindrical stock removal model.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  map2DTo4Axis, map4AxisTo2D, uFromA, aFromU, wrap, circumference,
} from '../src/core/unroll.js';
import { PROFILES, PATTERNS, makeDesign } from '../src/core/profiles.js';
import { generateProgram } from '../src/core/toolpath.js';
import { emitGcode, buildSegToLine, fmt1 } from '../src/core/gcode.js';
import { CylindricalStock } from '../src/stock/stock.js';
import { DEFAULTS } from '../src/config.js';

// ---------------------------------------------------------------------------
// Unroll math
// ---------------------------------------------------------------------------
test('map2DTo4Axis matches the spec blueprint', () => {
  const R0 = 25;
  const p = map2DTo4Axis(Math.PI * R0, 120, 5, R0); // half circumference
  assert.equal(p.A, 180);
  assert.equal(p.X, 120);
  assert.equal(p.Z, 20);
});

test('2D → 4-axis → 2D round-trip', () => {
  const R0 = 17.5;
  for (const [u, v, d] of [[0, 0, 0], [10, 55, 3], [100, 190, 12], [33.3, 1.2, 0.5]]) {
    const { X, Z, A } = map2DTo4Axis(u, v, d, R0);
    const back = map4AxisTo2D(X, Z, A, R0);
    assert.ok(Math.abs(back.U - wrap(u, circumference(R0))) < 1e-9, `U ${back.U} vs ${u}`);
    assert.ok(Math.abs(back.V - v) < 1e-9);
    assert.ok(Math.abs(back.depth - d) < 1e-9);
  }
});

test('uFromA / aFromU are consistent inverses on the map', () => {
  const R0 = 25;
  for (const a of [0, 45, 180, 720, 1440, -90]) {
    const u = uFromA(a, R0);
    const a2 = aFromU(u, R0);
    assert.ok(Math.abs(wrap(a - a2, 360)) < 1e-9 || Math.abs(wrap(a2 - a, 360)) < 1e-9);
  }
  assert.equal(uFromA(360, R0), 0); // full turn returns to U=0
});

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------
test('all preset profiles produce radii within (0, R0]', () => {
  const stock = { length: 200, R0: 25 };
  for (const p of PROFILES) {
    for (const pat of PATTERNS) {
      const d = makeDesign(
        { profile: p.id, pattern: pat.id, patternCount: 8, patternTurns: 2, patternDepth: 0.22, custom: '' },
        stock,
      );
      for (let i = 0; i <= 40; i++) {
        for (let j = 0; j <= 12; j++) {
          const r = d.targetRadius((j / 12) * circumference(25), (i / 40) * 200);
          assert.ok(r > 0 && r <= 25, `${p.id}/${pat.id} → ${r}`);
        }
      }
      assert.ok(d.minTarget() > 0 && d.minTarget() <= 25);
    }
  }
});

test('part-shape presets carry the expected silhouettes', () => {
  const stock = { length: 200, R0: 25 };
  const pr = (id, t) => makeDesign(
    { profile: id, pattern: 'none', patternCount: 8, patternTurns: 2, patternDepth: 0.2, custom: '' },
    stock,
  ).profileRadius(t * 200) / 25;
  // Bat: thin handle, fat barrel.
  assert.ok(pr('baseball-bat', 0.1) < 0.22 && pr('baseball-bat', 0.93) > 0.92);
  // Pawn: slim stem, wide base, round head.
  assert.ok(pr('chess-pawn', 0.35) < 0.25 && pr('chess-pawn', 0.02) > 0.7 && pr('chess-pawn', 0.86) > 0.68);
  // Bottle: full body, narrow neck.
  assert.ok(pr('bottle', 0.3) > 0.72 && pr('bottle', 0.85) < 0.3);
  // Spool: flanges with a thin core between them.
  assert.ok(pr('spool', 0.03) > 0.9 && pr('spool', 0.5) < 0.3 && pr('spool', 0.97) > 0.9);
  // Spinning top: pointed tip, fat belly.
  assert.ok(pr('spinning-top', 0.55) > 0.9 && pr('spinning-top', 1) < 0.1);
  // Stepped shaft: three distinct plateaus.
  assert.ok(Math.abs(pr('step-shaft', 0.1) - 0.52) < 0.02 && Math.abs(pr('step-shaft', 0.3) - 0.8) < 0.02
    && Math.abs(pr('step-shaft', 0.6) - 0.38) < 0.02);
  // Pulley: rim wider than the groove centre.
  assert.ok(pr('pulley', 0.05) > 0.85 && pr('pulley', 0.5) < 0.4);
});

test('custom JSON design: profile honoured, errors raised', () => {
  const stock = { length: 200, R0: 25 };
  const custom = JSON.stringify({ profile: [[0, 25], [100, 12.5], [200, 25]], pattern: 'none' });
  const d = makeDesign({ profile: 'cylinder', pattern: 'none', patternCount: 8, patternTurns: 0, patternDepth: 0.2, custom }, stock);
  assert.ok(Math.abs(d.targetRadius(0, 100) - 12.5) < 0.01);
  assert.throws(() => makeDesign({ ...DEFAULTS.design, custom: '{oops' }, stock), /Custom JSON/);
  assert.throws(() => makeDesign({ ...DEFAULTS.design, custom: '{"profile":[[0,5]]}' }, stock), /≥2/);
  assert.throws(() => makeDesign({ ...DEFAULTS.design, custom: '{"profile":[[0,5],["x",3]]}' }, stock), /Bad profile point/);
});

// ---------------------------------------------------------------------------
// Toolpath strategies
// ---------------------------------------------------------------------------
function gen(strategyOverrides = {}, toolOverrides = {}) {
  const stock = { length: 200, R0: 25 };
  const design = makeDesign(DEFAULTS.design, stock);
  const tool = { ...DEFAULTS.tool, ...toolOverrides };
  const strategy = { ...DEFAULTS.strategy, ...strategyOverrides };
  return {
    design,
    stock,
    program: generateProgram({ design, stock, tool, strategy, feeds: DEFAULTS.feeds, clearance: DEFAULTS.clearance }),
  };
}

for (const rough of ['indexed', 'spiral']) {
  for (const finish of ['helical', 'raster']) {
    test(`program is well-formed: rough=${rough} finish=${finish}`, () => {
      const { program, stock } = gen({ rough, finish });
      const segs = program.segments;
      assert.ok(segs.length > 100, 'expected a substantial program');
      for (const s of segs) {
        assert.ok(['G0', 'G1'].includes(s.mode));
        assert.ok(Number.isFinite(s.X) && Number.isFinite(s.Z) && Number.isFinite(s.A));
        assert.ok(s.X >= -0.001 && s.X <= 200.001);
        assert.ok(s.Z >= 0 && s.Z <= stock.R0 + DEFAULTS.clearance + 0.001);
      }
      assert.ok(program.stats.cutDist > 0 && program.stats.estSeconds > 0);
    });
  }
}

test('helical finishing is continuous synchronized X/A motion', () => {
  const { program, design, stock } = gen({ rough: '', finish: 'helical' }, {});
  const fin = program.segments.filter((s) => s.group === 'finish' && s.mode === 'G1');
  assert.ok(fin.length > 100);
  let prevA = fin[0].A, prevX = fin[0].X;
  for (const s of fin) {
    assert.ok(s.A >= prevA - 1e-9, 'A must accumulate monotonically (no wrap)');
    assert.ok(s.X >= prevX - 1e-9, 'X must advance monotonically');
    prevA = s.A; prevX = s.X;
  }
  // Exactly one revolution per pitch of X travel: total ΔA = 360 · L / pitch.
  const expected = 360 * (200 / DEFAULTS.strategy.pitch);
  assert.ok(Math.abs((prevA - fin[0].A) - expected) < DEFAULTS.strategy.angularStep + 1e-6);
  assert.ok(Math.abs(prevX - 200) < 1e-6, 'helix must end exactly at X = L');
});

test('finishing never cuts below the target surface', () => {
  for (const finish of ['helical', 'raster']) {
    const { program, design, stock } = gen({ rough: '', finish });
    for (const s of program.segments) {
      if (s.group !== 'finish' || s.mode !== 'G1') continue;
      const target = design.targetRadius(uFromA(s.A, stock.R0), s.X);
      assert.ok(s.Z >= target - 1e-6, `${finish}: Z=${s.Z} below target ${target}`);
    }
  }
});

test('roughing keeps the stair-step clamp above target + allowance', () => {
  for (const rough of ['indexed', 'spiral']) {
    const { program, design, stock } = gen({ rough, finish: '' });
    const allow = DEFAULTS.tool.allowance;
    for (const s of program.segments) {
      if (s.group !== 'rough' || s.mode !== 'G1') continue;
      const floor = design.targetRadius(uFromA(s.A, stock.R0), s.X) + allow;
      assert.ok(s.Z >= floor - 1e-6, `${rough}: rough block Z=${s.Z} broke below clamp floor ${floor}`);
    }
  }
});

test('raster finish covers the full unrolled circumference', () => {
  const { program, stock } = gen({ rough: '', finish: 'raster' });
  const stepover = DEFAULTS.tool.stepover;
  const circ = circumference(stock.R0);
  const cuts = program.segments.filter((s) => s.group === 'finish' && s.mode === 'G1');
  const Uset = [...new Set(cuts.map((s) => Math.round(uFromA(s.A, stock.R0) * 10) / 10))];
  assert.ok(Uset.length >= circ / stepover - 1, `raster lines: ${Uset.length}, expected ~${circ / stepover}`);
});

// ---------------------------------------------------------------------------
// G-code
// ---------------------------------------------------------------------------
test('G-code motion lines parse with correct axis words', () => {
  const { program } = gen({ rough: 'spiral', finish: 'helical' });
  const { lines } = emitGcode(program, { stock: { length: 200, diameter: 50 }, tool: { type: 'ball', diameter: 6 } });
  const lineRe = /^(G[01])(?: X-?\d+(?:\.\d+)?)?(?: Z-?\d+(?:\.\d+)?)?(?: A-?\d+(?:\.\d+)?)?(?: F\d+)?(?: \(.*\))?$/;
  let motions = 0;
  for (const l of lines) {
    if (/^G[01] /.test(l.text)) {
      assert.match(l.text, lineRe);
      const body = l.text.split(' (')[0];
      assert.ok(!/(^|\s)-0\.0(?=\s|$)/.test(body), `negative zero in ${l.text}`);
      motions++;
    }
  }
  assert.ok(motions > 100);
  assert.equal(lines[0].text, '%');
  assert.ok(lines.some((l) => l.text === 'G21 (UNITS: MILLIMETRES)'));
  assert.equal(lines[lines.length - 2].text, 'M30 (PROGRAM END)');
});

test('segment → line map covers every segment and highlights real motion', () => {
  const { program } = gen({ rough: 'indexed', finish: 'raster' });
  const { lines } = emitGcode(program, {});
  const map = buildSegToLine(lines, program.segments.length);
  assert.equal(map.length, program.segments.length);
  for (let i = 0; i < map.length; i++) {
    assert.ok(map[i] >= 0, `segment ${i} unresolved`);
    assert.match(lines[map[i]].text, /^G[01]/);
  }
});

test('fmt1 formats without -0.0 artefacts', () => {
  assert.equal(fmt1(-0.04), '0.0');
  assert.equal(fmt1(12.34), '12.3');
  assert.equal(fmt1(-8.16), '-8.2');
});

// ---------------------------------------------------------------------------
// Cylindrical stock model
// ---------------------------------------------------------------------------
test('flat endmill cuts a radial plane at top, nothing at the flank', () => {
  const s = new CylindricalStock(200, 25, 100, 120);
  const tool = { R: 4, ball: false };
  s.cutAt(100, 20, 0, tool); // X=100, Zc=20 at A=0 (top)
  const iMid = 50;
  assert.ok(Math.abs(s.radiusAt(iMid, 0) - 20) < 0.01, 'top cell cut to Zc');
  const j60 = Math.round((60 / 360) * 120); // Zc/cos60 = 40 > R0 → untouched
  assert.equal(s.radiusAt(iMid, j60), 25);
  // Cell exactly one column in (3°): flat rule gives Zc/cos(3°).
  const phi = (1 / 120) * 2 * Math.PI;
  assert.ok(Math.abs(s.radiusAt(iMid, 1) - 20 / Math.cos(phi)) < 0.005);
});

test('ball-nose leaves a spherical scallop', () => {
  const s = new CylindricalStock(200, 25, 100, 120);
  const tool = { R: 5, ball: true };
  s.cutAt(100, 21, 0, tool);
  const iMid = 50;
  const dx = s.xs[iMid] - 100;
  const h = 21 + 5;
  const ballR = (theta) => h * Math.cos(theta) - Math.sqrt(25 - dx * dx - h * h * Math.sin(theta) ** 2);
  // Dead-centre cell and one column over (3°): expect the sphere-envelope roots.
  assert.ok(Math.abs(s.radiusAt(iMid, 0) - ballR(0)) < 0.005, 'centre follows sphere');
  const t2 = (2 / 120) * 2 * Math.PI;
  assert.ok(Math.abs(s.radiusAt(iMid, 2) - ballR(t2)) < 0.005, 'scallop rises away from centre');
  const r2 = s.radiusAt(iMid, 2);
  assert.ok(r2 > s.radiusAt(iMid, 0) + 0.4, `groove is rounded (${r2} vs ${s.radiusAt(iMid, 0)})`);
  // Near the footprint edge (~11°) the sphere no longer reaches: untouched.
  assert.equal(s.radiusAt(iMid, 4), 25);
});

test('cuts are monotone and idempotent', () => {
  const s = new CylindricalStock(100, 20, 60, 96);
  const tool = { R: 3, ball: true };
  s.cutAt(50, 15, 10, tool);
  const snap = Float32Array.from(s.radii);
  s.cutAt(50, 15, 10, tool);
  for (let i = 0; i < snap.length; i++) assert.equal(s.radii[i], snap[i]);
});

test('A-rotation moves the cut footprint around the map', () => {
  const s = new CylindricalStock(100, 20, 60, 96);
  const tool = { R: 2.5, ball: false };
  s.cutAt(50, 15, 90, tool); // top contact happens at stock φ = A = 90°
  const j90 = 24; // 90/360 * 96
  assert.ok(Math.abs(s.radiusAt(30, j90) - 15) < 0.05, 'cell at φ=A is cut');
  assert.equal(s.radiusAt(30, 0), 20, 'cell at φ=0 untouched at A=90');
});

test('helical finishing converges a plain cylinder to the target radius', () => {
  const L = 160, R0 = 25, rT = 16;
  const stock = new CylindricalStock(L, R0, 90, 144);
  const tool = { R: 3, ball: true };
  const pitch = 2;         // mm/rev
  const aStep = 1;         // deg
  const total = 360 * (L / pitch);
  for (let a = 0; a <= total; a += aStep) {
    const x = Math.min((pitch * a) / 360, L);
    stock.cutAt(x, rT, a, tool);
  }
  // Interior cells (skip 6mm at each end where the tool overruns).
  let maxErr = 0, minR = Infinity;
  for (let i = 4; i < stock.nx - 4; i++) {
    for (let j = 0; j < stock.nth; j++) {
      const r = stock.radiusAt(i, j);
      maxErr = Math.max(maxErr, r - rT);
      minR = Math.min(minR, r);
    }
  }
  assert.ok(maxErr < 0.45, `max residual ${maxErr.toFixed(3)} mm above target`);
  assert.ok(minR > rT - 0.05, `overcut below target: ${minR}`);
});

test('mesh buffers stay finite and indexable', () => {
  const s = new CylindricalStock(150, 25, 40, 48);
  s.cutAt(75, 18, 45, { R: 4, ball: true });
  const pos = new Float32Array(s.meshVertexCount() * 3);
  const nrm = new Float32Array(s.meshVertexCount() * 3);
  s.buildMesh(pos, nrm);
  const idx = s.buildIndices();
  for (const v of pos) assert.ok(Number.isFinite(v));
  for (const v of nrm) assert.ok(Number.isFinite(v));
  let maxI = 0;
  for (const v of idx) maxI = Math.max(maxI, v);
  assert.ok(maxI < s.meshVertexCount());
});

test('removal volume accounting is positive and bounded by the cylinder', () => {
  const s = new CylindricalStock(100, 20, 80, 96);
  const tool = { R: 5, ball: false };
  for (let a = 0; a < 720; a += 2) s.cutAt(50, 10, a, tool);
  const fullCyl = Math.PI * 20 * 20 * 100;
  assert.ok(s.removedMm3 > 0);
  assert.ok(s.removedMm3 < fullCyl);
});
