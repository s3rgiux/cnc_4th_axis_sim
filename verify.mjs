/**
 * verify.mjs — headless browser smoke test for the simulator UI.
 * Dev-only helper (requires playwright-core + a local Chrome); the shipped app
 * itself has zero dependencies. Run with the server up:
 *   node serve.mjs 8090 &   node verify.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const PAGE_URL = process.env.URL || 'http://127.0.0.1:8090/';
const OUT = new globalThis.URL('shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const step = (m) => console.log(`• ${m}`);

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(PAGE_URL, { waitUntil: 'load' });
await page.waitForSelector('#term .ln', { timeout: 15000 });
step('app booted, gcode terminal populated');

// WebGL actually rendering?
const glOk = await page.evaluate(() => {
  const c = document.querySelector('#v3d canvas');
  return !!c && c.width > 100 && c.height > 100;
});
if (!glOk) errors.push('3D canvas missing or zero-sized');
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT + '01-idle-3d.png' });
step('3D viewport rendered');

// Continuous A present in generated program (default helical finish)?
const contA = await page.evaluate(() =>
  [...document.querySelectorAll('#term .ln')].some((el) => /A\d{4,}(\.\d+)?(?=\s|$)/.test(el.textContent)));
if (!contA) errors.push('no continuous (multi-turn) A values in G-code');
step(`continuous A words: ${contA}`);

// Three-phase tool header (rough / finish / detail)?
const toolHdr = await page.evaluate(() =>
  [...document.querySelectorAll('#term .ln')].filter((el) => /^\(TOOL: T\d/.test(el.textContent)).length);
if (toolHdr < 3) errors.push(`expected 3 per-phase TOOL header lines, got ${toolHdr}`);
step(`per-phase tool header lines: ${toolHdr}`);

// --- play: material must be removed -------------------------------------------------
// With 3-phase allowances the first roughing level legitimately rides above the
// wide parts of the profile (no cut over the leg's foot), so play at 50× and
// poll until the first real cut (cap ~15 s).
await page.evaluate(() => {
  const s = document.getElementById('sl-speed');
  s.value = 9; s.dispatchEvent(new Event('input', { bubbles: true })); // 50×
});
await page.click('#btn-play');
let playState = { a: 0, removed: 0 };
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500);
  playState = await page.evaluate(() => ({
    a: parseFloat(document.getElementById('dro-a').textContent),
    removed: parseFloat(document.getElementById('lbl-removed').textContent),
  }));
  if (playState.removed > 0) break;
}
await page.evaluate(() => {
  const s = document.getElementById('sl-speed');
  s.value = 4; s.dispatchEvent(new Event('input', { bubbles: true })); // back to 2×
});
step(`playing 50× → A=${playState.a.toFixed(1)}° removed=${playState.removed.toFixed(2)} cm³`);
if (!(playState.removed > 0)) errors.push('no material removed while playing');
await page.screenshot({ path: OUT + '02-cutting-3d.png' });

// --- fps sample (SwiftShader is slow; measure without asserting 60) ------------------
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; performance.now() - t0 < 2000 ? requestAnimationFrame(tick) : res((n * 1000) / (performance.now() - t0)); };
  requestAnimationFrame(tick);
}));
step(`rAF throughput (software GL): ${fps.toFixed(1)} fps`);

// --- 2D unrolled map ------------------------------------------------------------
await page.click('#tab-2d');
await page.waitForTimeout(700);
const has2d = await page.evaluate(() => {
  const c = document.querySelector('#v2d canvas');
  if (!c) return false;
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let coloured = 0;
  for (let i = 0; i < d.length; i += 400) if (d[i] > 40 || d[i + 1] > 90) coloured++;
  return coloured > 50;
});
if (!has2d) errors.push('2D canvas appears blank');
await page.screenshot({ path: OUT + '03-unrolled-2d.png' });
step('2D unrolled map drawn');

// --- split view -----------------------------------------------------------------
await page.click('#tab-split');
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + '04-split.png' });
step('split view');

// --- step controls + scrub ----------------------------------------------------------
await page.click('#tab-3d');
await page.click('#btn-reset');
await page.waitForTimeout(300);
const afterReset = await page.evaluate(() => parseFloat(document.getElementById('lbl-removed').textContent));
if (afterReset !== 0) errors.push('reset did not restore stock');
await page.click('#btn-fwd'); await page.click('#btn-fwd'); await page.click('#btn-fwd');
await page.waitForTimeout(250);
const afterSteps = await page.evaluate(() => parseFloat(document.getElementById('dro-a').textContent));
step(`reset + 3× step-fwd → A=${afterSteps.toFixed(1)}° removed=${afterReset}`);
await page.evaluate(() => {
  const s = document.getElementById('sl-scrub');
  s.value = 600; s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1200); // backward seeks re-simulate
const scrubbed = await page.evaluate(() => ({
  a: parseFloat(document.getElementById('dro-a').textContent),
  removed: parseFloat(document.getElementById('lbl-removed').textContent),
}));
if (!(scrubbed.removed > 0)) errors.push('scrub to 60% removed no material');
step(`scrub 60% → A=${scrubbed.a.toFixed(1)}° removed=${scrubbed.removed.toFixed(1)} cm³`);
await page.screenshot({ path: OUT + '05-scrub-60.png' });

// --- strategy switching -------------------------------------------------------------
for (const [sel, val] of [['#sel-rough', 'indexed'], ['#sel-finish', 'raster']]) {
  await page.selectOption(sel, val);
  await page.waitForTimeout(900);
}
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + '06-indexed-raster.png' });
const statusTxt = await page.textContent('#status');
step(`indexed+raster → status "${statusTxt.trim()}"`);

// --- custom design round-trip (valid + invalid) ---------------------------------------
await page.fill('#ta-custom', JSON.stringify({ profile: [[0, 25], [90, 14], [200, 25]], pattern: 'reeding', patternCount: 12 }));
await page.click('#btn-custom');
await page.waitForTimeout(900);
await page.screenshot({ path: OUT + '07-custom.png' });
await page.fill('#ta-custom', '{ broken');
await page.click('#btn-custom');
await page.waitForTimeout(400);
const errTxt = await page.textContent('#status');
if (!/Design error/.test(errTxt)) errors.push('invalid custom JSON not reported');
step(`bad JSON reported: "${errTxt.trim()}"`);
await page.fill('#ta-custom', '');
await page.selectOption('#sel-profile', 'classic-leg');
await page.dispatchEvent('#sel-profile', 'change');
await page.waitForTimeout(900);

// --- STL import: procedural baroque demo leg ------------------------------------------
await page.click('#btn-reset');
await page.click('#btn-demoleg');
await page.waitForFunction(() => /table-leg\.stl.*unrolled/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
step('demo leg imported → ' + (await page.textContent('#status')).trim().slice(0, 90));
const profVal = await page.evaluate(() => document.getElementById('sel-profile').value);
if (profVal !== 'imported') errors.push('profile select did not switch to "imported"');
await page.click('#tab-2d');
await page.waitForTimeout(700);
await page.screenshot({ path: OUT + '08-imported-2d.png' });
await page.click('#tab-3d');
await page.evaluate(() => {
  const s = document.getElementById('sl-scrub');
  s.value = 1000; s.dispatchEvent(new Event('input', { bubbles: true })); // full carve
});
await page.waitForTimeout(3500);
const legRemoved = await page.evaluate(() => parseFloat(document.getElementById('lbl-removed').textContent));
if (!(legRemoved > 50)) errors.push(`demo leg full carve only ${legRemoved} cm³`);
step(`demo leg fully machined → removed=${legRemoved.toFixed(1)} cm³`);
await page.screenshot({ path: OUT + '09-imported-carve.png' });

// clean shot of the machined leg: ONE click on the master "toolpath" switch
// hides every path trace in both views (ghost turned off separately).
await page.evaluate(() => {
  for (const id of ['chk-ghost', 'chk-paths']) {
    const c = document.getElementById(id);
    c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await page.waitForTimeout(600);
const pathOff = await page.evaluate(() => {
  const { view3d, view2d } = window.__dbg;
  return {
    v3: ['rapid', 'rough', 'finish', 'detail'].every((k) => !view3d.pathMeshes[k].all.visible && !view3d.pathMeshes[k].done.visible),
    v2: Object.values(view2d.pathVisible).every((v) => !v),
    subsDisabled: document.getElementById('chk-p-rough').disabled,
  };
});
if (!pathOff.v3) errors.push('master toolpath switch left 3D path meshes visible');
if (!pathOff.v2) errors.push('master toolpath switch left 2D path layers visible');
if (!pathOff.subsDisabled) errors.push('per-group path checkboxes not disabled while master off');
step('master toolpath switch hides all path traces in 3D + 2D');
await page.screenshot({ path: OUT + '09b-imported-leg-clean.png' });
await page.evaluate(() => {
  for (const id of ['chk-ghost', 'chk-paths']) {
    const c = document.getElementById(id);
    c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

// --- OBJ import through the file input (synthetic twisted column) ---------------------
const OBJ = (() => {
  const lines = []; const NP = 24, NT = 10, L = 120;
  for (let i = 0; i <= NT; i++) for (let j = 0; j < NP; j++) {
    const t = i / NT, phi = (j / NP) * Math.PI * 2 + t * 1.2; // twist
    lines.push(`v ${(16 * Math.sin(phi)).toFixed(3)} ${(t * L).toFixed(3)} ${(16 * Math.cos(phi)).toFixed(3)}`);
  }
  for (let i = 0; i < NT; i++) for (let j = 0; j < NP; j++) {
    const a = i * NP + j + 1, b = (i + 1) * NP + j + 1, c = (i + 1) * NP + (j + 1) % NP + 1, d = i * NP + (j + 1) % NP + 1;
    lines.push(`f ${a} ${b} ${c}`, `f ${a} ${c} ${d}`);
  }
  return lines.join('\n');
})();
await page.setInputFiles('#file-mesh', { name: 'twist.obj', mimeType: 'text/plain', buffer: Buffer.from(OBJ) });
await page.waitForFunction(() => /twist\.obj/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
step('OBJ file-input import → ' + (await page.textContent('#status')).trim().slice(0, 80));

// --- keyboard shortcuts -----------------------------------------------------------------
await page.keyboard.press('Space');
await page.waitForTimeout(600);
const playingNow = await page.evaluate(() => document.getElementById('btn-play').textContent);
step(`Space → play button shows "${playingNow}"`);
await page.keyboard.press('KeyP');
const pOff = await page.evaluate(() => document.getElementById('chk-paths').checked);
if (pOff) errors.push('P shortcut did not toggle the toolpath master switch');
await page.keyboard.press('KeyP');
step('P shortcut toggles the toolpath master switch');

// --- M1: carriage frame must never enter the swept stock circle -------------------------
// World frame: rotary axis = world X at y=0,z=0; swept stock = cylinder radius R0 over
// x∈[0,L]. For each structural carriage member, over the full carriage travel, its AABB
// is tested with the SAME pure detector the app uses (core/collision.js via __dbg.collide).
// A negative control (a frame member dropped onto the axis) proves the detector fires.
async function setStock(len, dia) {
  await page.evaluate(([len, dia]) => {
    for (const [id, v] of [['num-len', len], ['num-dia', dia]]) {
      const el = document.getElementById(id); el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, [len, dia]);
  await page.waitForTimeout(400);
}
async function scanFrame(label) {
  const r = await page.evaluate(() => {
    const { view3d, stock, collide } = window.__dbg;
    const m = view3d.machine;
    const L = stock.length, R0 = stock.R0;
    const aabb = (mesh) => {
      const p = mesh.geometry.attributes.position, e = mesh.matrixWorld.elements;
      let ny = Infinity, xy = -Infinity, nz = Infinity, xz = -Infinity, nx = Infinity, xx = -Infinity;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (wx < nx) nx = wx; if (wx > xx) xx = wx;
        if (wy < ny) ny = wy; if (wy > xy) xy = wy;
        if (wz < nz) nz = wz; if (wz > xz) xz = wz;
      }
      return [nx, xx, ny, xy, nz, xz];
    };
    const hits = [];
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      m.carriage.position.x = f * L; view3d.scene.updateMatrixWorld(true);
      for (const mesh of m.frameMeshes) {
        if (collide.aabbVsSweptCylinder(aabb(mesh), L, R0)) hits.push(mesh.geometry.type);
      }
    }
    // negative control: clone a member onto the axis; the detector MUST flag it.
    m.carriage.position.x = L / 2;
    const bad = m.frameMeshes[m.frameMeshes.length - 1].clone();
    bad.position.set(0, 0, 0); m.carriage.add(bad); m.frameMeshes.push(bad);
    view3d.scene.updateMatrixWorld(true);
    const ctl = collide.aabbVsSweptCylinder(aabb(bad), L, R0);
    m.frameMeshes.pop(); m.carriage.remove(bad);
    return { L, R0, hits, ctlOk: ctl };
  });
  step(`carriage frame clear: L=${r.L} R0=${r.R0} — violations=${r.hits.length}${r.hits.length ? '(' + r.hits.join(',') + ')' : ''}, control=${r.ctlOk ? 'ok' : 'BROKEN'}`);
  if (r.hits.length) errors.push(`carriage collides with stock (L=${r.L},R0=${r.R0}): ${r.hits.join(',')}`);
  if (!r.ctlOk) errors.push('carriage collision detector did not fire on injected overlap — check is broken');
}
for (const [len, dia] of [[200, 50], [360, 120], [10, 6]]) {
  await setStock(len, dia);
  await scanFrame(`L${len}xD${dia}`);
}

// --- M4: static collision analysis + red overlay ------------------------------------------
// 1) the generated program must be flagged clean; 2) the pure detector must fire on a
// synthetic gouging/enveloping program (negative control); 3) the warning line stays
// hidden while clean; 4) the red overlay actually renders.
await setStock(200, 50);
const m4 = await page.evaluate(() => {
  const { sim, collide, view3d, program } = window.__dbg;
  const clean = sim.analysis.findings.length;
  const synth = collide.analyzeProgram({
    segments: [
      { mode: 'G0', X: 0, Z: 29, A: 0 },
      { mode: 'G0', X: 100, Z: 20, A: 0 }, // axial rapid below Zc → envelope
      { mode: 'G0', X: 50, Z: 8, A: 0 },   // dips below finished r=10 → gouge
    ],
  }, {
    design: { targetRadius: () => 10 },
    stock: { length: 100, R0: 25 },
    clearance: 4,
    limits: { xMin: -5, xMax: 450, zMin: 0.05, zMax: 120 },
  });
  const kinds = synth.findings.map((f) => f.kind);
  // render proof: paint a synthetic finding on the live scene
  const s6 = program.segments[6];
  view3d.setCollisions(program.segments, [{ segIdx: 6, kind: 'gouge', X: s6.X, Z: s6.Z, A: s6.A }]);
  return { clean, kinds, warnHidden: document.getElementById('collide-warn').hidden };
});
step(`M4 analysis: live findings=${m4.clean}, synthetic detector=[${m4.kinds.join(',')}]`);
if (m4.clean !== 0) errors.push(`generated program flagged ${m4.clean} collisions`);
if (!m4.kinds.includes('gouge') || !m4.kinds.includes('envelope')) {
  errors.push('collision detector missed synthetic envelope/gouge rapids — check is broken');
}
if (!m4.warnHidden) errors.push('collision warning visible on a clean program');
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + '10-collision-overlay.png' });
await page.evaluate(() => window.__dbg.view3d.setCollisions(window.__dbg.program.segments, []));
step('collision overlay rendered red then cleared (shots/10-collision-overlay.png)');

// --- 3-phase tools: V-bit detailing + per-phase cutter in the spindle ----------------------
// Switch the detailing cutter to a 60° V-bit; the program must regenerate with
// a detail group, the status stay clean, and the spindle load the V-bit cone.
await page.selectOption('#sel-dtool', 'vbit');
await page.dispatchEvent('#sel-dtool', 'change');
await page.waitForTimeout(1200);
const vbit = await page.evaluate(() => {
  const p = window.__dbg.program;
  const det = p.segments.filter((s) => s.group === 'detail' && s.mode === 'G1');
  return {
    detail: det.length,
    status: document.getElementById('status').textContent,
    vbitPreview: document.getElementById('pv-detail').innerHTML.includes('V-BIT'),
    angRow: document.getElementById('lbl-dang').style.display !== 'none',
  };
});
if (!vbit.detail) errors.push('V-bit detailing produced no detail segments');
if (/error/i.test(vbit.status)) errors.push(`V-bit detailing errored: ${vbit.status.trim()}`);
if (!vbit.vbitPreview) errors.push('tool preview SVG did not update to the V-bit cross-section');
if (!vbit.angRow) errors.push('V angle input not revealed when V-bit selected');
step(`V-bit detailing: ${vbit.detail} detail blocks, preview + angle row live`);
// Play the detailing phase to prove the per-phase cutter swaps in the spindle.
await page.evaluate(() => {
  const s = document.getElementById('sl-scrub');
  s.value = 920; s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1500);
const phaseTool = await page.evaluate(() => ({
  group: window.__dbg.sim.pose.group,
  removed: parseFloat(document.getElementById('lbl-removed').textContent),
}));
step(`scrub 92% → group=${phaseTool.group} removed=${phaseTool.removed.toFixed(1)} cm³`);
await page.screenshot({ path: OUT + '11-detail-vbit.png' });

await browser.close();

if (errors.length) {
  console.error('\nFAILURES:');
  for (const e of errors) console.error(' ✗', e);
  process.exit(1);
}
console.log('\nALL BROWSER CHECKS PASSED');
