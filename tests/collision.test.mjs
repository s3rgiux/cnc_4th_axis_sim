/**
 * Unit tests for src/core/collision.js — the static advisory checks:
 * rapid gouges, rapids inside the raw-stock envelope, overtravel, and the
 * AABB-vs-swept-cylinder detector shared with the browser smoke test.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aabbVsSweptCylinder, machineEnvelopeCheck, rapidsGougeCheck,
  overtravelCheck, analyzeProgram, KIND,
} from '../src/core/collision.js';
import { makeDesign } from '../src/core/profiles.js';
import { generateProgram } from '../src/core/toolpath.js';
import { DEFAULTS } from '../src/config.js';

// Synthetic world used by most checks: L=100, R0=25 → Zc=29, flat target r=10.
const CTX = {
  R0: 25,
  length: 100,
  clearance: 4,
  design: { targetRadius: () => 10, profileRadius: () => 10, minTarget: () => 10 },
};
const seg = (mode, X, Z, A, F = 0, group = 'rapid') => ({ mode, X, Z, A, F, group });

// ---------------------------------------------------------------------------
// AABB vs swept stock cylinder (M1 detector)
// ---------------------------------------------------------------------------
test('aabbVsSweptCylinder: gantry post clears the swing, axis-straddler hits', () => {
  // side post: inner face y=82, spans x with the carriage — clears R=60 swing
  assert.equal(aabbVsSweptCylinder([10, 66, 82, 98, -128, 156], 200, 60), false);
  // negative control: a member dropped onto the rotary axis must collide
  assert.equal(aabbVsSweptCylinder([10, 66, -8, 8, -8, 8], 200, 60), true);
  // bridge high above the work: quadrature gap ≫ R
  assert.equal(aabbVsSweptCylinder([-25, 225, -106, 106, 156, 184], 200, 60), false);
});

test('aabbVsSweptCylinder: boxes axially outside the work never hit', () => {
  assert.equal(aabbVsSweptCylinder([210, 260, -10, 10, -10, 10], 200, 60), false);
  assert.equal(aabbVsSweptCylinder([-60, -10, -10, 10, -10, 10], 200, 60), false);
  // tolerance keeps a headstock face touching x=0 "in contact", not clear
  assert.equal(aabbVsSweptCylinder([-56, -0.01, -10, 10, -10, 10], 200, 60), true);
});

test('machineEnvelopeCheck reports named violators only', () => {
  const frames = [
    { name: 'post', aabb: [0, 56, 82, 98, 0, 156] },
    { name: 'bad-member', aabb: [0, 56, -5, 5, -5, 5] },
  ];
  const hits = machineEnvelopeCheck(frames, 200, 60);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'bad-member');
  assert.match(hits[0].msg, /swept stock envelope/);
});

// ---------------------------------------------------------------------------
// Rapid gouge / envelope checks
// ---------------------------------------------------------------------------
test('clean program: rapids at Zc and radial retracts raise nothing', () => {
  const segs = [
    seg('G0', 0, 29, 0),                       // home
    seg('G1', 50, 20, 720, 1000, 'rough'),     // cutting
    seg('G0', 50, 29, 720),                    // radial retract (ΔX=0)
    seg('G0', 100, 29, 0),                     // axial rapid at clearance
  ];
  assert.deepEqual(rapidsGougeCheck(segs, CTX), []);
});

test('axial rapid below the finished surface → gouge at the right block', () => {
  const segs = [
    seg('G0', 0, 29, 0),
    seg('G1', 50, 12, 0, 1000, 'finish'),
    seg('G0', 100, 8, 0),                      // X-travel at Z8 < target 10
  ];
  const hits = rapidsGougeCheck(segs, CTX);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].segIdx, 2);
  assert.equal(hits[0].kind, KIND.GOUGE);
  assert.match(hits[0].msg, /finished surface/);
});

test('axial rapid between target and Zc → envelope advisory', () => {
  const segs = [seg('G0', 0, 29, 0), seg('G0', 100, 20, 0)];
  const hits = rapidsGougeCheck(segs, CTX);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, KIND.ENVELOPE);
  assert.match(hits[0].msg, /raw stock/);
});

test('gouge outranks envelope when both apply on one move', () => {
  const segs = [seg('G0', 0, 29, 0), seg('G0', 100, 5, 0)]; // crosses both bands
  const hits = rapidsGougeCheck(segs, CTX);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, KIND.GOUGE);
});

test('a rapid leaving FROM below the finished surface also gouges', () => {
  const segs = [seg('G0', 0, 29, 0), seg('G1', 50, 8, 0, 800), seg('G0', 90, 29, 0)];
  const hits = rapidsGougeCheck(segs, CTX);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].segIdx, 2);
  assert.equal(hits[0].kind, KIND.GOUGE);
});

test('without a design the gouge band degrades to envelope-only', () => {
  const segs = [seg('G0', 0, 29, 0), seg('G0', 100, 8, 0)];
  const hits = rapidsGougeCheck(segs, { ...CTX, design: null });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, KIND.ENVELOPE);
});

test('rapids entirely beyond the work span are ignored', () => {
  const segs = [seg('G0', 110, 29, 0), seg('G0', 150, 20, 0)];
  assert.deepEqual(rapidsGougeCheck(segs, CTX), []);
});

test('the home block itself is never flagged', () => {
  const segs = [seg('G0', 0, 5, 0), seg('G1', 10, 5, 0, 500, 'finish')];
  assert.deepEqual(rapidsGougeCheck(segs, CTX), []);
});

// ---------------------------------------------------------------------------
// Overtravel
// ---------------------------------------------------------------------------
test('overtravel flags X/Z beyond limits but never continuous A', () => {
  const limits = { xMin: -5, xMax: 450, zMin: 0.05, zMax: 120 };
  const segs = [
    seg('G0', 0, 29, 0),
    seg('G1', 500, 20, 24000, 1000, 'finish'), // X over, A huge (fine)
    seg('G1', 10, -1, 24000, 1000, 'finish'),  // Z below axis
  ];
  const hits = overtravelCheck(segs, limits);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.axis), ['X', 'Z']);
  assert.ok(hits.every((h) => h.kind === KIND.OVERTRAVEL));
});

// ---------------------------------------------------------------------------
// Integration: every strategy combo the generator produces must be clean
// ---------------------------------------------------------------------------
test('generated programs are collision-free for all rough×finish combos', () => {
  const stock = { length: 200, R0: 25 };
  const design = makeDesign(
    { ...DEFAULTS.design, profile: 'classic-leg', pattern: 'spiral', patternCount: 8 },
    stock,
  );
  for (const rough of ['', 'indexed', 'spiral']) {
    for (const finish of ['helical', 'raster']) {
      const program = generateProgram({
        design,
        stock,
        tool: DEFAULTS.tool,
        strategy: { ...DEFAULTS.strategy, rough, finish },
        feeds: DEFAULTS.feeds,
        clearance: DEFAULTS.clearance,
      });
      const res = analyzeProgram(program, {
        design,
        stock,
        clearance: DEFAULTS.clearance,
        limits: DEFAULTS.machine,
      });
      assert.ok(
        res.ok,
        `${rough || 'no-rough'} × ${finish}: ${res.findings.length} findings, first: ` +
        `${res.findings[0]?.msg} (seg ${res.findings[0]?.segIdx})`,
      );
    }
  }
});

test('analyzeProgram merges, sorts and summarizes findings', () => {
  const program = {
    segments: [
      seg('G0', 0, 29, 0),
      seg('G0', 100, 20, 0),      // envelope: axial rapid below Zc
      seg('G0', 100, 8, 0),       // gouge: radial rapid below target r=10
      seg('G0', 500, 29, 0),      // X overtravel (leaves from outside the span)
    ],
  };
  const res = analyzeProgram(program, {
    design: CTX.design,
    stock: { length: CTX.length, R0: CTX.R0 },
    clearance: CTX.clearance,
    limits: { xMin: -5, xMax: 450, zMin: 0.05, zMax: 120 },
  });
  assert.equal(res.ok, false);
  assert.equal(res.counts.envelope, 1);
  assert.equal(res.counts.gouge, 1);
  assert.equal(res.counts.overtravel, 1);
  assert.deepEqual(res.findings.map((f) => f.segIdx), [1, 2, 3]); // sorted by block
  assert.match(res.summary, /1 rapid gouge/);
  assert.match(res.summary, /1 axial rapid/);
  assert.match(res.summary, /1 overtravel/);
});