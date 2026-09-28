/**
 * Simulated residue / gouge verification (core/residue.js): the program is
 * played through the real Simulator + CylindricalStock and the final surface
 * is diffed against the design skin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDesign, PROFILES } from '../src/core/profiles.js';
import { generateProgram } from '../src/core/toolpath.js';
import { analyzeResidue, buildFloor, residueStats } from '../src/core/residue.js';
import { CylindricalStock } from '../src/stock/stock.js';
import { KIND } from '../src/core/collision.js';
import { DEFAULTS, gridFor } from '../src/config.js';

const STOCK = { length: 200, R0: 25 };

function programFor(profile, overrides = {}) {
  const design = makeDesign({ ...DEFAULTS.design, profile, ...(overrides.design || {}) }, STOCK);
  const strategy = { ...DEFAULTS.strategy, ...(overrides.strategy || {}) };
  const program = generateProgram({
    design, stock: STOCK, tools: DEFAULTS.tools, allowance: DEFAULTS.allowance,
    strategy, feeds: DEFAULTS.feeds, clearance: DEFAULTS.clearance,
  });
  return { design, program, strategy };
}

function analyze(profile, overrides = {}) {
  const { design, program, strategy } = programFor(profile, overrides);
  const grid = gridFor(STOCK.length, STOCK.R0);
  const allow = strategy.detail ? DEFAULTS.allowance.detail : DEFAULTS.allowance.finish;
  return { design, program, res: analyzeResidue(program, {
    design, stock: STOCK, grid, tools: DEFAULTS.tools, feeds: DEFAULTS.feeds, allow,
  }) };
}

test('buildFloor clamps the skin to R0 and follows the design', () => {
  const design = makeDesign({ ...DEFAULTS.design, profile: 'classic-leg' }, STOCK);
  const stock = new CylindricalStock(200, 25, 40, 48);
  const floor = buildFloor(design, stock, 0.5);
  for (let i = 0; i < stock.nx; i++) {
    for (let j = 0; j < stock.nth; j++) {
      const f = floor[i * stock.nth + j];
      assert.ok(f <= 25 + 1e-6, 'floor never above R0');
      const t = design.targetRadius((j / stock.nth) * 2 * Math.PI * 25, stock.xs[i]) + 0.5;
      assert.ok(Math.abs(f - Math.min(t, 25)) < 1e-5);
    }
  }
});

test('residueStats separates gouge from rest material', () => {
  const stock = new CylindricalStock(100, 20, 20, 32);
  const floor = new Float32Array(stock.nx * stock.nth).fill(18);
  stock.radii.fill(18);                 // on target
  stock.radii[5 * stock.nth + 3] = 17;  // 1 mm gouge
  stock.radii[9 * stock.nth + 8] = 19.5; // 1.5 mm rest
  const st = residueStats(stock, floor, 0.05);
  assert.equal(st.gougeCells, 1);
  assert.equal(st.residueCells, 1);
  assert.ok(Math.abs(st.maxGouge - 1) < 1e-5 && Math.abs(st.maxResidue - 1.5) < 1e-5);
  assert.deepEqual(st.gougeAt, { i: 5, j: 3 });
});

test('a plain cylinder at R0 needs no cutting and reports clean', () => {
  const { res } = analyze('cylinder');
  assert.ok(res.maxGouge <= res.tol, `gouge ${res.maxGouge}`);
  assert.ok(res.maxResidue <= res.tol, `residue ${res.maxResidue}`);
  assert.equal(res.findings.length, 0);
});

test('gouges are attributed to the feed segments that made them', () => {
  // A deliberately gouging program: finishing skin at 0 with a Ø4 ball but a
  // tool descriptor that is actually a Ø12 ball → the flank bites the walls.
  const { design, program } = programFor('step-shaft', { strategy: { rough: '', detail: false } });
  const grid = gridFor(STOCK.length, STOCK.R0);
  const tools = structuredClone(DEFAULTS.tools);
  tools.finish.diameter = 12;
  const res = analyzeResidue(program, {
    design, stock: STOCK, grid, tools, feeds: DEFAULTS.feeds, allow: DEFAULTS.allowance.finish,
  });
  assert.ok(res.maxGouge > 0.5, `expected a real gouge, got ${res.maxGouge}`);
  assert.ok(res.findings.length > 0);
  for (const f of res.findings) {
    assert.equal(f.kind, KIND.CUTGOUGE);
    assert.equal(program.segments[f.segIdx].mode, 'G1');
    assert.ok(f.depth > res.tol);
    assert.equal(f.group, 'finish');
  }
  assert.ok(/cut .* below the final skin/.test(res.findings[0].msg));
  assert.ok(res.summary.includes('gouge'));
});

test('every preset program is gouge-free within tolerance', () => {
  // Acceptance for the offset-surface generator: the tool VOLUME never breaks
  // the final skin on any built-in shape (tip-on-surface planning gouged the
  // step-shaft by 7 mm and the diamond pattern by 6 mm).
  for (const p of PROFILES) {
    const { res } = analyze(p.id);
    assert.ok(res.maxGouge <= res.tol, `${p.id}: gouge ${res.maxGouge.toFixed(3)} mm at cell ${JSON.stringify(res.gougeAt)}`);
  }
  const pat = analyze('classic-leg', { design: { pattern: 'diamond' } });
  assert.ok(pat.res.maxGouge <= pat.res.tol, `diamond: gouge ${pat.res.maxGouge.toFixed(3)} mm`);
  for (const finish of ['hybrid', 'waterline', 'raster']) {
    const r = analyze('step-shaft', { strategy: { finish } });
    assert.ok(r.res.maxGouge <= r.res.tol, `${finish}: gouge ${r.res.maxGouge.toFixed(3)} mm`);
  }
  const idx = analyze('spool', { strategy: { rough: 'indexed' } });
  assert.ok(idx.res.maxGouge <= idx.res.tol, `indexed: gouge ${idx.res.maxGouge.toFixed(3)} mm`);
});

test('the naive tip-on-surface planner gouges (the reason offsets exist)', () => {
  const { design, program } = programFor('step-shaft', { strategy: { offset: false } });
  const grid = gridFor(STOCK.length, STOCK.R0);
  const res = analyzeResidue(program, {
    design, stock: STOCK, grid, tools: DEFAULTS.tools, feeds: DEFAULTS.feeds, allow: DEFAULTS.allowance.detail,
  });
  assert.ok(res.maxGouge > 1, `expected the legacy planner to gouge deeply, got ${res.maxGouge}`);
});
