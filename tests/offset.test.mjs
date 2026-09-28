/**
 * Tool-offset surface (core/offset.js) and adaptive sampling (core/adaptive.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDesign } from '../src/core/profiles.js';
import { makeOffsetSurface } from '../src/core/offset.js';
import { adaptiveLine } from '../src/core/adaptive.js';
import { CylindricalStock } from '../src/stock/stock.js';
import { DEFAULTS, gridFor } from '../src/config.js';

const STOCK = { length: 200, R0: 25 };
const GRID = gridFor(200, 25);

/** Linear ramp of slope g between x=60 and x=76 (collinear points → exact line). */
function rampDesign(g) {
  const prof = [[0, 25], [60, 25]];
  for (let x = 62; x <= 76; x += 2) prof.push([x, 25 - (x - 60) * g]);
  prof.push([200, 25 - 16 * g]);
  return makeDesign({ ...DEFAULTS.design, custom: JSON.stringify({ profile: prof }) }, STOCK);
}

test('offset of a plain cylinder is the target + allowance', () => {
  const d = makeDesign({ ...DEFAULTS.design, profile: 'cylinder' }, STOCK);
  for (const tool of [{ type: 'ball', diameter: 4 }, { type: 'flat', diameter: 10 }, { type: 'vbit', diameter: 1, angle: 60 }]) {
    const o = makeOffsetSurface(d, tool, 0.5, STOCK, GRID);
    for (const [x, a] of [[10, 0], [100, 37.3], [190, 359]]) {
      assert.ok(Math.abs(o.tipAt(x, a) - 25.5) < 1e-3, `${tool.type}: ${o.tipAt(x, a)}`);
    }
  }
});

test('ball and flat lifts on a slope match the analytic offsets', () => {
  for (const g of [0.5, 1.0]) {
    const d = rampDesign(g);
    const beta = Math.atan(g);
    const ball = makeOffsetSurface(d, { type: 'ball', diameter: 4 }, 0, STOCK, GRID);
    const liftB = ball.tipAt(68, 0) - ball.targetAt(68, 0);
    const wantB = 2 * (1 - Math.cos(beta)) / Math.cos(beta);
    assert.ok(Math.abs(liftB - wantB) < 0.03, `ball slope ${g}: lift ${liftB} vs ${wantB}`);
    const flat = makeOffsetSurface(d, { type: 'flat', diameter: 10 }, 0, STOCK, GRID);
    const liftF = flat.tipAt(68, 0) - flat.targetAt(68, 0);
    assert.ok(Math.abs(liftF - 5 * g) < 0.1, `flat slope ${g}: lift ${liftF} vs ${5 * g}`);
  }
});

test('offset is never below the centre target and the pruned search equals brute force', () => {
  const d = makeDesign({ ...DEFAULTS.design, profile: 'classic-leg', pattern: 'diamond' }, STOCK);
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const tool of [{ type: 'ball', diameter: 1 }, { type: 'flat', diameter: 10 }, { type: 'vbit', diameter: 6, angle: 90 }]) {
    const o = makeOffsetSurface(d, tool, 0.1, STOCK, GRID);
    for (let k = 0; k < 300; k++) {
      const x = rnd() * 200, a = rnd() * 360;
      const fast = o.tipAt(x, a);
      assert.ok(fast >= o.targetAt(x, a) - 1e-9);
      assert.ok(Math.abs(fast - o.tipAtBrute(x, a)) < 1e-6, `${tool.type} pruning mismatch at ${x},${a}`);
    }
  }
});

test('cutting at the offset height never breaks the target on the stock grid', () => {
  // The decisive property: for random poses, applying the real cutter at
  // Z = tipAt leaves every cell at or above target.
  const d = makeDesign({ ...DEFAULTS.design, profile: 'spool', pattern: 'reeding' }, STOCK);
  const stock = new CylindricalStock(200, 25, GRID.nx, GRID.nth);
  const floor = new Float32Array(GRID.nx * GRID.nth);
  for (let i = 0; i < GRID.nx; i++) {
    for (let j = 0; j < GRID.nth; j++) floor[i * GRID.nth + j] = d.targetRadius((j / GRID.nth) * 2 * Math.PI * 25, stock.xs[i]);
  }
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const tool of [{ type: 'ball', diameter: 1 }, { type: 'ball', diameter: 4 }, { type: 'flat', diameter: 10 }, { type: 'vbit', diameter: 1, angle: 60 }]) {
    const o = makeOffsetSurface(d, tool, 0, STOCK, GRID);
    const cutter = { R: tool.diameter / 2, shape: tool.type, angle: tool.angle };
    for (let k = 0; k < 400; k++) {
      const x = rnd() * 200, a = rnd() * 360;
      stock.reset();
      stock.cutAt(x, o.tipAt(x, a), a, cutter, floor);
      assert.ok(stock.lastMaxGouge < 1e-4, `${tool.type} gouged ${stock.lastMaxGouge} at ${x},${a}`);
    }
  }
});

test('upperAt bounds the offset for every rotary angle', () => {
  const d = makeDesign({ ...DEFAULTS.design, profile: 'chess-pawn' }, STOCK);
  const o = makeOffsetSurface(d, { type: 'flat', diameter: 10 }, 3, STOCK, GRID);
  for (let x = 0; x <= 200; x += 7.3) {
    const ub = o.upperAt(x);
    for (let a = 0; a < 360; a += 23) assert.ok(o.tipAt(x, a) <= ub + 1e-6, `x=${x} a=${a}`);
  }
});

test('adaptiveLine: straight floors collapse to few blocks, bends get refined', () => {
  const flat = adaptiveLine(() => 20, [0, 0], [0, 360], { tol: 0.02, coarse: 1, maxDA: 10, R0: 25 });
  assert.ok(flat.length <= 40 && flat.length >= 30, `flat blocks ${flat.length}`); // capped by maxDA
  assert.ok(Math.abs(flat[flat.length - 1][1] - 360) < 1e-9, 'ends exactly at the target');
  const bumpy = adaptiveLine((x) => 20 + 2 * Math.sin(x), [0, 0], [30, 0], { tol: 0.01, coarse: 2, R0: 25 });
  assert.ok(bumpy.length > 60, `bumpy blocks ${bumpy.length}`);
  // Every emitted chord stays within the ASYMMETRIC tolerance of the floor at
  // fine resolution: the floor may sit at most ~tol above a chord (gouge
  // side), the chord at most ~4·tol above the floor (air side).
  let prev = [0, 0, 20 + 2 * Math.sin(0)];
  for (const p of bumpy) {
    for (let t = 0; t <= 1; t += 0.1) {
      const x = prev[0] + (p[0] - prev[0]) * t;
      const z = prev[2] + (p[2] - prev[2]) * t;
      const floor = 20 + 2 * Math.sin(x);
      assert.ok(floor - z < 0.015, `floor above chord by ${(floor - z).toFixed(4)} at x=${x}`);
      assert.ok(z - floor < 0.05, `chord above floor by ${(z - floor).toFixed(4)} at x=${x}`);
    }
    prev = p;
  }
});

test('adaptiveLine: a step in the floor becomes an explicit vertical move on the safe side', () => {
  const up = adaptiveLine((x) => (x < 10 ? 10 : 12), [0, 0], [20, 0], { tol: 0.02, coarse: 5, minStep: 0.01, R0: 25 });
  // Rising step: the rise happens at or before the step position.
  const rise = up.find((p) => Math.abs(p[2] - 12) < 1e-9);
  assert.ok(rise && rise[0] <= 10 + 1e-6, `rise at x=${rise && rise[0]}`);
  const down = adaptiveLine((x) => (x < 10 ? 12 : 10), [0, 0], [20, 0], { tol: 0.02, coarse: 5, minStep: 0.01, R0: 25 });
  // Falling step: the tool holds 12 until at/after the step, then drops.
  let lastHigh = -1;
  for (const p of down) if (Math.abs(p[2] - 12) < 1e-9) lastHigh = p[0];
  assert.ok(lastHigh >= 10 - 1e-6, `held high until x=${lastHigh}`);
  for (const p of down) if (p[0] < 10 - 1e-6) assert.ok(p[2] >= 12 - 1e-9, 'never below the high floor before the step');
});
