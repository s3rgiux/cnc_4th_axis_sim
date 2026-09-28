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
function gen(strategyOverrides = {}, toolsOverride = null) {
  const stock = { length: 200, R0: 25 };
  const design = makeDesign(DEFAULTS.design, stock);
  const tools = structuredClone(DEFAULTS.tools);
  if (toolsOverride) for (const [k, v] of Object.entries(toolsOverride)) Object.assign(tools[k], v);
  const strategy = { ...DEFAULTS.strategy, ...strategyOverrides };
  return {
    design,
    stock,
    program: generateProgram({
      design, stock, tools, allowance: DEFAULTS.allowance,
      strategy, feeds: DEFAULTS.feeds, clearance: DEFAULTS.clearance,
    }),
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
  const { program, design, stock } = gen({ rough: '', finish: 'helical', scallop: false }, {});
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

test('each phase floors at target + its own allowance, in order', () => {
  const { program, design, stock } = gen({ rough: 'spiral', finish: 'helical' });
  const A = DEFAULTS.allowance;
  assert.ok(A.rough > A.finish && A.finish > A.detail, 'defaults must leave progressively less');
  const floors = { rough: A.rough, finish: A.finish, detail: A.detail };
  for (const s of program.segments) {
    if (s.mode !== 'G1' || !(s.group in floors)) continue;
    const floor = design.targetRadius(uFromA(s.A, stock.R0), s.X) + floors[s.group];
    assert.ok(s.Z >= floor - 1e-6, `${s.group}: Z=${s.Z} broke its floor ${floor}`);
  }
});

test('detailing is a third phase with its own tool, feed and pitch', () => {
  const { program } = gen({ rough: '', finish: 'helical', scallop: false });
  const det = program.segments.filter((s) => s.group === 'detail' && s.mode === 'G1');
  assert.ok(det.length > 100, 'detail group present and substantial');
  assert.ok(det.every((s) => s.F === DEFAULTS.feeds.detail), 'detail feed applied');
  const dA = det[det.length - 1].A - det[0].A;
  const expected = 360 * (200 / DEFAULTS.strategy.detailPitch);
  assert.ok(Math.abs(dA - expected) <= DEFAULTS.strategy.angularStep + 1e-6,
    `detail helix pitch: ΔA=${dA} expected≈${expected}`);
  // Finishing runs strictly before detailing in program order.
  let finEnd = -1, detStart = Infinity;
  program.segments.forEach((s, i) => {
    if (s.group === 'finish') finEnd = i;
    if (s.group === 'detail' && detStart === Infinity) detStart = i;
  });
  assert.ok(finEnd < detStart, 'phase order: finish then detail');
});

test('constant-scallop helix shrinks the pitch on axial slopes', () => {
  // The classic leg has steep coves: constant-scallop mode must turn MORE
  // revolutions than the fixed pitch would, never fewer.
  const fixed = gen({ rough: '', finish: 'helical', detail: false, scallop: false });
  const scal = gen({ rough: '', finish: 'helical', detail: false, scallop: true });
  const turns = (p) => {
    const fin = p.program.segments.filter((s) => s.group === 'finish' && s.mode === 'G1');
    return (fin[fin.length - 1].A - fin[0].A) / 360;
  };
  const tf = turns(fixed), ts = turns(scal);
  assert.ok(Math.abs(tf - 200 / DEFAULTS.strategy.pitch) < 0.01, `fixed turns ${tf}`);
  assert.ok(ts > tf * 1.02, `scallop turns ${ts} should exceed fixed ${tf}`);
  assert.ok(ts < tf * 4.01, 'pitch never drops below a quarter');
});

test('detail off emits no detail group', () => {
  const { program } = gen({ rough: '', finish: 'helical', detail: false });
  assert.equal(program.segments.filter((s) => s.group === 'detail').length, 0);
});

test('roughing keeps the stair-step clamp above target + allowance', () => {
  for (const rough of ['indexed', 'spiral']) {
    const { program, design, stock } = gen({ rough, finish: '', detail: false });
    const allow = DEFAULTS.allowance.rough;
    for (const s of program.segments) {
      if (s.group !== 'rough' || s.mode !== 'G1') continue;
      const floor = design.targetRadius(uFromA(s.A, stock.R0), s.X) + allow;
      assert.ok(s.Z >= floor - 1e-6, `${rough}: rough block Z=${s.Z} broke below clamp floor ${floor}`);
    }
  }
});

test('waterline finishing traces constant-Z contours; hybrid adds them only on steep walls', () => {
  const stock = { length: 200, R0: 25 };
  const design = makeDesign({ ...DEFAULTS.design, profile: 'step-shaft' }, stock);
  const run = (finish) => generateProgram({
    design, stock, tools: DEFAULTS.tools, allowance: DEFAULTS.allowance,
    strategy: { ...DEFAULTS.strategy, rough: '', detail: false, finish },
    feeds: DEFAULTS.feeds, clearance: DEFAULTS.clearance,
  });
  const wl = run('waterline');
  const cuts = wl.segments.filter((s) => s.group === 'finish' && s.mode === 'G1');
  assert.ok(cuts.length > 200, 'waterline emitted contour blocks');
  // Within a contour run, consecutive cutting blocks share Z (constant-Z passes)
  // except where the run had to lift above the level to respect the floor.
  let sameZ = 0, moves = 0;
  for (let i = 1; i < cuts.length; i++) {
    if (Math.abs(cuts[i].A - cuts[i - 1].A) < 1e-9 && Math.abs(cuts[i].X - cuts[i - 1].X) < 1e-9) continue; // plunge
    moves++;
    if (Math.abs(cuts[i].Z - cuts[i - 1].Z) < 1e-6) sameZ++;
  }
  assert.ok(sameZ / moves > 0.8, `constant-Z share ${(sameZ / moves).toFixed(2)}`);
  // Never below the finishing floor (target + allowance).
  for (const s of cuts) {
    const floor = design.targetRadius(uFromA(s.A, stock.R0), s.X) + DEFAULTS.allowance.finish;
    assert.ok(s.Z >= floor - 1e-6, `waterline block below floor: ${s.Z} < ${floor}`);
  }
  const hel = run('helical'), hyb = run('hybrid');
  assert.ok(hyb.segments.length > hel.segments.length + 100, 'hybrid adds steep-wall passes on the step shaft');
  const leg = makeDesign({ ...DEFAULTS.design, profile: 'taper' }, stock);
  const flat = generateProgram({
    design: leg, stock, tools: DEFAULTS.tools, allowance: DEFAULTS.allowance,
    strategy: { ...DEFAULTS.strategy, rough: '', detail: false, finish: 'hybrid' },
    feeds: DEFAULTS.feeds, clearance: DEFAULTS.clearance,
  });
  const flatHel = generateProgram({
    design: leg, stock, tools: DEFAULTS.tools, allowance: DEFAULTS.allowance,
    strategy: { ...DEFAULTS.strategy, rough: '', detail: false, finish: 'helical' },
    feeds: DEFAULTS.feeds, clearance: DEFAULTS.clearance,
  });
  assert.equal(flat.segments.length, flatHel.segments.length, 'no steep walls on a taper → hybrid adds nothing');
});

test('spiral roughing skips air turns where the previous level left nothing', () => {
  // Spool: full-radius flanges at both ends. Their rough floor (target + 3 mm)
  // sits above every level, so every turn over a flange is air after the
  // first pass and must be hopped with a rapid instead of cut.
  const stock = { length: 200, R0: 25 };
  const design = makeDesign({ ...DEFAULTS.design, profile: 'spool' }, stock);
  const prog = generateProgram({
    design, stock, tools: DEFAULTS.tools, allowance: DEFAULTS.allowance,
    strategy: { ...DEFAULTS.strategy, rough: 'spiral', detail: false },
    feeds: DEFAULTS.feeds, clearance: DEFAULTS.clearance,
  });
  const roughG0 = prog.segments.filter((s) => s.group === 'rough' && s.mode === 'G0');
  assert.ok(roughG0.length > 2 * prog.stats.levels + 4, `expected air hops, got ${roughG0.length} rough rapids`);
  // No rough cut ever happens over the flanges below the flange floor.
  const Zc = stock.R0 + DEFAULTS.clearance;
  for (const s of prog.segments) {
    if (s.group !== 'rough' || s.mode !== 'G1') continue;
    if (s.X < 10 || s.X > 190) {
      const floor = design.targetRadius(uFromA(s.A, stock.R0), s.X) + DEFAULTS.allowance.rough;
      assert.ok(s.Z >= Math.min(floor, Zc) - 1e-6, `flange cut below floor at X=${s.X}`);
    }
  }
});

test('raster finish covers the full unrolled circumference', () => {
  const { program, stock } = gen({ rough: '', finish: 'raster', detail: false });
  const stepover = DEFAULTS.tools.finish.stepover;
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

test('G-code header lists one tool per phase with allowances', () => {
  const { program } = gen({ rough: 'spiral', finish: 'helical' });
  const { lines } = emitGcode(program, {
    stock: { length: 200, diameter: 50 },
    tools: [
      { t: 1, phase: 'ROUGH', ...DEFAULTS.tools.rough, allow: DEFAULTS.allowance.rough },
      { t: 2, phase: 'FINISH', ...DEFAULTS.tools.finish, allow: DEFAULTS.allowance.finish },
      { t: 3, phase: 'DETAIL', ...DEFAULTS.tools.detail, allow: DEFAULTS.allowance.detail },
    ],
  });
  const head = lines.slice(0, 12).map((l) => l.text).join('\n');
  assert.match(head, /T1 FLAT ENDMILL D=10\.0 ROUGH ALLOW=3\.0/);
  assert.match(head, /T2 BALL-NOSE D=4\.0 FINISH ALLOW=0\.5/);
  assert.match(head, /T3 BALL-NOSE D=1\.0 DETAIL ALLOW=0\.1/);
});

test('G-code header names a V-bit phase', () => {
  const { program } = gen({ rough: '', finish: 'helical' }, { detail: { type: 'vbit', angle: 60 } });
  const { lines } = emitGcode(program, {
    stock: { length: 200, diameter: 50 },
    tools: [{ t: 3, phase: 'DETAIL', ...DEFAULTS.tools.detail, type: 'vbit', angle: 60, allow: 0.1 }],
  });
  assert.ok(lines.some((l) => /T3 V-BIT 60\.0DEG D=1\.0 DETAIL/.test(l.text)));
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

test('v-bit cuts straight flanks at the included angle', () => {
  // nx=101 over L=200 → xs[50] = 100 exactly, so dx per column is known.
  const s = new CylindricalStock(200, 25, 101, 120);
  const tool = { R: 0.1, shape: 'vbit', angle: 90 }; // tan 45° = 1
  s.cutAt(100, 20, 0, tool);
  const iMid = 50;
  assert.ok(Math.abs(s.radiusAt(iMid, 0) - 20) < 0.05, 'tip flat cuts to Zc dead centre');
  // 90° included → flank rises 1 mm per mm lateral from the tip edge.
  assert.ok(Math.abs(s.radiusAt(iMid + 1, 0) - (20 + (2 - 0.1))) < 0.05, 'flank at dx=2');
  assert.ok(Math.abs(s.radiusAt(iMid + 2, 0) - (20 + (4 - 0.1))) < 0.05, 'flank at dx=4');
  assert.equal(s.radiusAt(iMid + 3, 0), 25, 'beyond the flank reach: untouched');
  // A ray steeper than the 45° flank (θw=60°) is never cut.
  const j60 = 20; // 60° of 360 at nth=120
  assert.equal(s.radiusAt(iMid, j60), 25, 'steep ray untouched');
  // Idempotent like every other cutter.
  const snap = Float32Array.from(s.radii);
  s.cutAt(100, 20, 0, tool);
  for (let i = 0; i < snap.length; i++) assert.equal(s.radii[i], snap[i]);
});

test('narrow v-bit cuts a deeper narrower groove', () => {
  const s = new CylindricalStock(200, 25, 101, 120);
  const tool = { R: 0.05, shape: 'vbit', angle: 30 }; // tan 15° ≈ 0.268
  s.cutAt(100, 15, 0, tool);
  const t = Math.tan(15 * Math.PI / 180);
  const dx = 2;
  // Flank height above the tip grows as (d − Rt)/tan α: narrow → deep.
  assert.ok(Math.abs(s.radiusAt(51, 0) - (15 + (dx - 0.05) / t)) < 0.05, '30° flank slope');
  assert.equal(s.radiusAt(55, 0), 25, 'narrow cone does not reach dx=10 at this depth');
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
