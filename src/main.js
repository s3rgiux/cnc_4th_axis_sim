/**
 * main.js — application orchestrator.
 *
 * Wires together: control panel → design → toolpath generation → G-code post
 * → stock simulation → 3D + 2D views → playback transport. One rAF loop drives
 * rendering and, when playing, advances the simulation clock at feed rate ×
 * speed multiplier.
 */
import { DEFAULTS } from './config.js';
import { makeDesign } from './core/profiles.js';
import { parseSTL, parseOBJ, projectToCylinder, makeHeightmapDesign } from './core/mesh.js';
import { generateProgram } from './core/toolpath.js';
import { emitGcode, buildSegToLine } from './core/gcode.js';
import * as collide from './core/collision.js';
import { CylindricalStock } from './stock/stock.js';
import { Simulator } from './app/sim.js';
import { View3D } from './scene/view3d.js';
import { View2D } from './scene/view2d.js';
import { UI } from './app/ui.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Live parameter set (mutated by the UI).
const params = structuredClone(DEFAULTS);

let view3d, view2d, stock, sim;
let design = null, program = null, gcodeData = null, segToLine = null;
let importedProj = null; // cylindrical unroll of an imported STL/OBJ mesh
let playing = false;
let speedMult = 2;
let currentView = 'show-3d';
let lastFrame = performance.now();
let lastFramedL = -1;

// Path-overlay visibility: one master "toolpath" switch ∧ the per-group
// checkboxes. The finished part otherwise sits under thousands of path lines.
const PATH_CHECKS = [
  ['rapid', 'chk-p-rapid'], ['rough', 'chk-p-rough'],
  ['finish', 'chk-p-finish'], ['detail', 'chk-p-detail'],
];
function applyPathVisibility() {
  const master = $('chk-paths').checked;
  for (const [name, id] of PATH_CHECKS) {
    const v = master && $(id).checked;
    view3d.setGroupVisible(name, v);
    view2d.pathVisible[name] = v;
  }
}

// --------------------------------------------------------------------------
// Handlers invoked by the UI layer
// --------------------------------------------------------------------------
const handlers = {
  onParamsChanged: () => rebuild(),
  onGenerate: () => rebuild('Toolpath regenerated'),
  onExport: exportGcode,
  onCustom: () => rebuild('Custom design applied'),

  onPlay: () => {
    if (!program || !program.segments.length) return;
    if (sim.dist >= sim.totalDist) sim.reset(); // replay from the top
    playing = true;
    ui.setPlaying(true);
  },
  onPause: () => { playing = false; ui.setPlaying(false); },
  onReset: () => {
    playing = false;
    ui.setPlaying(false);
    sim.reset();
    ui.removed(0);
  },
  onStepF: () => { playing = false; ui.setPlaying(false); sim.stepNext(); },
  onStepB: () => { playing = false; ui.setPlaying(false); sim.stepPrev(); },
  onScrub: (frac) => sim.setProgress(frac),
  onSpeed: (m) => { speedMult = m; },
  onView: (name) => {
    currentView = `show-${name}`;
    // Give the just-shown view a fresh size (ResizeObserver covers this too).
    if (name !== '2d') view3d.resizeNow();
  },
  onToggle: (key, val) => {
    if (key === 'ghost') {
      view3d.setGhostVisible(val);
      view2d.setGhostVisible(val);
    } else if (key === 'paths') {
      ui.setPathsEnabled(val);
      applyPathVisibility();
    } else {
      applyPathVisibility(); // per-group box: effective = master ∧ group
    }
  },

  onMeshFile: (file) => file.arrayBuffer().then((buf) => importMesh(file.name, buf)),
  onMeshDemo: () =>
    fetch('assets/table-leg.stl')
      .then((res) => {
        if (!res.ok) throw new Error(`assets/table-leg.stl → HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => importMesh('table-leg.stl', buf))
      .catch((err) => ui.status(`Demo leg error: ${err.message}`, true)),
};

// --------------------------------------------------------------------------
// 3D mesh import: STL/OBJ → unroll onto the cylindrical map → carve
// --------------------------------------------------------------------------
async function importMesh(name, buffer) {
  try {
    ui.status(`Importing ${name}…`);
    await new Promise((r) => setTimeout(r, 30)); // let the status paint
    const tris = /\.obj$/i.test(name)
      ? parseOBJ(new TextDecoder().decode(buffer))
      : parseSTL(buffer);
    const L = clamp(params.stock.length || 200, 10, 360);
    const R0 = clamp(params.stock.diameter || 50, 6, 120) / 2;
    importedProj = projectToCylinder(tris.pos, tris.count, {
      length: L, R0, nx: DEFAULTS.grid.nx, nth: DEFAULTS.grid.nth,
    });
    importedProj.name = name;
    params.design.profile = 'imported';
    params.design.custom = ''; // an import supersedes any applied custom JSON
    ui.setProfile('imported');
    rebuild(
      `${name}: ${tris.count.toLocaleString()} tris unrolled to a ` +
      `${DEFAULTS.grid.nx}×${DEFAULTS.grid.nth} (V×U) design map — axis ${importedProj.meta.axis.toUpperCase()}, ` +
      `scale ${importedProj.meta.scaleAxis}×`,
    );
  } catch (err) {
    importedProj = null;
    ui.status(`Import error: ${err.message}`, true);
  }
}

let ui; // hoisted; defined below

// --------------------------------------------------------------------------
// Rebuild pipeline: params → design → program → views
// --------------------------------------------------------------------------
function rebuild(okMsg) {
  const L = clamp(params.stock.length || 200, 10, 360);
  const D = clamp(params.stock.diameter || 50, 6, 120);
  const R0 = D / 2;

  try {
    design = params.design.profile === 'imported' && importedProj
      ? makeHeightmapDesign(importedProj, L, R0, importedProj.name || 'model')
      : makeDesign(params.design, { length: L, R0 });
  } catch (err) {
    ui.status(`Design error: ${err.message}`, true);
    return;
  }

  program = generateProgram({
    design,
    stock: { length: L, R0 },
    tools: params.tools,
    allowance: params.allowance,
    strategy: params.strategy,
    feeds: params.feeds,
    clearance: params.clearance,
  });

  if (!program.segments.length) {
    ui.status('Nothing to generate — enable a strategy.', true);
    return;
  }

  const toolName = (t) => (t.type === 'ball' ? 'Ball-nose' : t.type === 'vbit' ? `V-bit ${t.angle}°` : 'Flat endmill');
  const phaseLabel = (k) => `${toolName(params.tools[k])} Ø${params.tools[k].diameter}→${params.allowance[k]}mm`;
  const strategyLabel = [
    params.strategy.rough ? `ROUGH ${phaseLabel('rough')}` : 'no rough',
    `FINISH ${phaseLabel('finish')}`,
    params.strategy.detail ? `DETAIL ${phaseLabel('detail')}` : null,
  ].filter(Boolean).join(' + ');
  gcodeData = emitGcode(program, {
    stock: { length: L, diameter: D },
    tools: [
      { t: 1, phase: 'ROUGH', ...params.tools.rough, allow: params.allowance.rough },
      { t: 2, phase: 'FINISH', ...params.tools.finish, allow: params.allowance.finish },
      { t: 3, phase: 'DETAIL', ...params.tools.detail, allow: params.allowance.detail },
    ],
    designName: params.design.profile === 'imported' && importedProj
      ? `imported:${importedProj.name || 'model'}`
      : (params.design.custom && params.design.custom.trim() ? 'custom' : params.design.profile),
    strategyText: strategyLabel,
  });
  segToLine = buildSegToLine(gcodeData.lines, program.segments.length);

  // Stock geometry + simulator
  stock.resize(L, R0, DEFAULTS.grid.nx, DEFAULTS.grid.nth);
  sim.setTools(params.tools);
  sim.feeds = params.feeds;
  sim.load(program, { design, clearance: params.clearance, limits: params.machine });

  // 3D scene
  view3d.setStock(stock);
  view3d.machine.setStockLength(L);
  lastToolPhase = null;                    // force the cutter rebuild below
  applyPhaseTool(sim.pose);
  view3d.setGhost(design, L, R0, $('chk-ghost').checked);
  view3d.setPaths(program);
  applyPathVisibility(); // re-assert master ∧ per-group state on the fresh geometry
  if (lastFramedL !== L) view3d.resetView(L);
  lastFramedL = L;

  // 2D map
  view2d.setProgram(stock, design, program, sim.cumDist);

  playing = false;
  ui.setPlaying(false);
  sim.reset(); // pose → home, stock refilled, callbacks fire
  ui.setGcode(gcodeData.lines);
  ui.statsDisplay(program.stats);
  ui.removed(0);
  ui.setScrub(0);
  ui.setTime(0, sim.totalSeconds);

  // Static collision advisory (M4): red overlay in 3D + persistent warning.
  view3d.setCollisions(program.segments, sim.analysis.findings);
  const first = sim.analysis.findings[0];
  ui.collisionWarn(sim.analysis, first ? segToLine[first.segIdx] + 1 : 0);

  const roughTxt = params.strategy.rough ? `rough:${params.strategy.rough}` : 'rough:off';
  const detailTxt = params.strategy.detail ? ' + detail' : '';
  ui.status(okMsg || `${program.stats.nG1} cutting blocks · ${program.stats.nG0} rapids · ${roughTxt} + ${params.strategy.finish}${detailTxt}`);
}

// --------------------------------------------------------------------------
// Per-pose visual sync
// --------------------------------------------------------------------------
// The spindle follows the program: while a group plays, its cutter is loaded.
let lastToolPhase = null;
function activePhase(pose) {
  const g = pose && pose.group;
  if (g === 'rough' || g === 'finish' || g === 'detail') return g;
  return params.strategy.rough ? 'rough' : params.strategy.detail ? 'detail' : 'finish';
}
function applyPhaseTool(pose) {
  const phase = activePhase(pose);
  if (phase === lastToolPhase) return;
  lastToolPhase = phase;
  const t = params.tools[phase];
  view3d.machine.setTool(t.type, t.diameter, t.angle);
  view2d.setToolRadius(t.diameter / 2);
}

function onPose(pose, segIdx) {
  view3d.updateStock(); // no-op unless cuts happened since last rebuild
  view3d.setRotor(pose.A);
  view3d.setProgress(segIdx - 1); // segments strictly before current are done
  view3d.machine.updatePose(pose.X, pose.Z);
  applyPhaseTool(pose);
  ui.dro(pose);
  ui.highlightLine(segIdx < 0 || !segToLine ? -1 : segToLine[segIdx]);
  ui.setTime(sim.elapsedSeconds(), sim.totalSeconds);
  ui.removed(stock.removedCm3);
  if (playing) ui.setScrub(sim.progress);
}

// --------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------
function exportGcode() {
  if (!gcodeData) return;
  const blob = new Blob([gcodeData.text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'part.nc';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  ui.status(`Exported part.nc (${gcodeData.lines.length} lines)`);
}

// --------------------------------------------------------------------------
// Keyboard shortcuts
// --------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    playing ? handlers.onPause() : handlers.onPlay();
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    handlers.onStepF();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    handlers.onStepB();
  } else if (e.code === 'KeyP') {
    const cb = $('chk-paths');
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

// --------------------------------------------------------------------------
// Main animation loop
// --------------------------------------------------------------------------
function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1); // tab-away safe
  lastFrame = now;

  if (playing && sim.totalDist > 0) {
    const done = sim.advance((speedMult * sim.feedAt() * dt) / 60);
    if (done) {
      playing = false;
      ui.setPlaying(false);
      ui.status('Program complete');
    }
    ui.removed(stock.removedCm3);
  }

  view3d.render();
  if (currentView === 'show-2d' || currentView === 'show-split') view2d.draw(sim.pose);

  requestAnimationFrame(frame);
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
ui = new UI(params, handlers);
view3d = new View3D($('v3d'));
view2d = new View2D($('v2d'));
stock = new CylindricalStock(
  params.stock.length,
  params.stock.diameter / 2,
  DEFAULTS.grid.nx,
  DEFAULTS.grid.nth,
);
sim = new Simulator(stock, params.tools, params.feeds);
sim.onUpdate = onPose;
view2d.onSeek = (d) => {
  playing = false;
  ui.setPlaying(false);
  sim.advanceTo(d);
};
speedMult = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 50][Number($('sl-speed').value)] || 2;

rebuild('Ready — press ▶ to machine');
requestAnimationFrame(frame);

// QA/test hook (read-only): lets external scripts inspect scene geometry.
window.__dbg = { view3d, view2d, stock, sim, params, collide, get program() { return program; } };
