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

// --- play: material must be removed -------------------------------------------------
await page.click('#btn-play');
await page.waitForTimeout(2500);
const playState = await page.evaluate(() => ({
  a: parseFloat(document.getElementById('dro-a').textContent),
  removed: parseFloat(document.getElementById('lbl-removed').textContent),
}));
step(`playing → A=${playState.a.toFixed(1)}° removed=${playState.removed.toFixed(2)} cm³`);
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

// clean shot of the machined leg without path/ghost overlays
await page.evaluate(() => {
  for (const id of ['chk-ghost', 'chk-p-rough', 'chk-p-finish']) {
    const c = document.getElementById(id);
    c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + '09b-imported-leg-clean.png' });
await page.evaluate(() => {
  for (const id of ['chk-ghost', 'chk-p-rough', 'chk-p-finish']) {
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

await browser.close();

if (errors.length) {
  console.error('\nFAILURES:');
  for (const e of errors) console.error(' ✗', e);
  process.exit(1);
}
console.log('\nALL BROWSER CHECKS PASSED');
