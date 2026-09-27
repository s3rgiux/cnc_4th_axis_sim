/**
 * ui.js — DOM control layer: control panel bindings, transport bar, DRO,
 * G-code terminal with live highlighting, stats readouts.
 * Pure view layer; every mutation flows out through the `handlers` callbacks.
 */
import { PROFILES, PATTERNS } from '../core/profiles.js';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 50];
const $ = (id) => document.getElementById(id);

export function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class UI {
  /**
   * @param {object} params shared parameter object (mutated in place)
   * @param {object} h handlers {onParamsChanged, onGenerate, onExport, onPlay,
   *   onPause, onReset, onStepF, onStepB, onScrub(f), onSpeed(mult),
   *   onView(name), onToggle(key,val), onCustom()}
   */
  constructor(params, h) {
    this.params = params;
    this.h = h;
    this.termEls = [];
    this.hlIdx = -1;
    this.playing = false;

    this._fillSelects();
    this._bindPanel();
    this._bindTransport();
    this._bindViewport();
  }

  _fillSelects() {
    $('sel-profile').innerHTML = PROFILES.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')
      + '<option value="imported">— Imported 3D model —</option>';
    $('sel-pattern').innerHTML = PATTERNS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    $('sel-profile').value = this.params.design.profile;
    $('sel-pattern').value = this.params.design.pattern;
  }

  _bindPanel() {
    this.paramMap = {
      'num-len': ['stock', 'length', 'num'],
      'num-dia': ['stock', 'diameter', 'num'],
      'sel-profile': ['design', 'profile', 'str'],
      'sel-pattern': ['design', 'pattern', 'str'],
      'num-pcount': ['design', 'patternCount', 'num'],
      'num-pturns': ['design', 'patternTurns', 'num'],
      'num-pdepth': ['design', 'patternDepth', 'num'],
      'sel-tool': ['tool', 'type', 'str'],
      'num-tool-d': ['tool', 'diameter', 'num'],
      'num-stepover': ['tool', 'stepover', 'num'],
      'num-doc': ['tool', 'doc', 'num'],
      'num-allow': ['tool', 'allowance', 'num'],
      'sel-rough': ['strategy', 'rough', 'str'],
      'num-roughpitch': ['strategy', 'roughPitch', 'num'],
      'num-indexes': ['strategy', 'indexes', 'int'],
      'sel-finish': ['strategy', 'finish', 'str'],
      'num-pitch': ['strategy', 'pitch', 'num'],
      'num-astep': ['strategy', 'angularStep', 'num'],
      'num-frough': ['feeds', 'rough', 'num'],
      'num-ffinish': ['feeds', 'finish', 'num'],
      'num-frapid': ['feeds', 'rapid', 'num'],
    };
    for (const id of Object.keys(this.paramMap)) {
      $(id).addEventListener('change', () => {
        this.readParams();
        this._scheduleRegen();
      });
    }
    const syncIdxVis = () => {
      $('lbl-indexes').style.display = $('sel-rough').value === 'indexed' ? '' : 'none';
    };
    $('sel-rough').addEventListener('change', syncIdxVis);
    syncIdxVis();

    // Picking a profile (preset or imported) is an explicit intent: it
    // overrides any custom JSON still sitting in params from an earlier Apply.
    $('sel-profile').addEventListener('change', () => {
      this.params.design.custom = '';
    });

    $('btn-generate').addEventListener('click', () => {
      this.readParams();
      this.h.onGenerate();
    });
    $('btn-export').addEventListener('click', () => this.h.onExport());
    $('btn-custom').addEventListener('click', () => {
      this.params.design.custom = $('ta-custom').value;
      this.h.onCustom();
    });

    // --- 3D model import (STL / OBJ) -------------------------------------
    $('btn-import').addEventListener('click', () => $('file-mesh').click());
    $('file-mesh').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) this.h.onMeshFile(f);
    });
    $('btn-demoleg').addEventListener('click', () => this.h.onMeshDemo());
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /\.(stl|obj)$/i.test(f.name)) this.h.onMeshFile(f);
      else if (f) this.status('Drop an .stl or .obj file', true);
    });
  }

  /** Reflect the active design in the profile dropdown. */
  setProfile(id) {
    const sel = $('sel-profile');
    sel.value = id;
    if (sel.value !== id) { // 'imported' option missing → add it
      const o = document.createElement('option');
      o.value = id; o.textContent = 'Imported 3D model';
      sel.appendChild(o);
      sel.value = id;
    }
  }

  _scheduleRegen() {
    clearTimeout(this._regenT);
    this._regenT = setTimeout(() => this.h.onParamsChanged(), 250);
  }

  readParams() {
    for (const [id, [g, k, t]] of Object.entries(this.paramMap)) {
      const raw = $(id).value;
      this.params[g][k] = t === 'str' ? raw : t === 'int' ? Math.max(1, Math.round(Number(raw) || 0)) : Number(raw);
    }
  }

  _bindTransport() {
    $('btn-play').addEventListener('click', () => (this.playing ? this.h.onPause() : this.h.onPlay()));
    $('btn-reset').addEventListener('click', () => this.h.onReset());
    $('btn-back').addEventListener('click', () => this.h.onStepB());
    $('btn-fwd').addEventListener('click', () => this.h.onStepF());
    $('sl-speed').addEventListener('input', (e) => {
      const m = SPEEDS[Number(e.target.value)] ?? 1;
      $('sp-speed').textContent = `${m}×`;
      this.h.onSpeed(m);
    });
    $('sl-scrub').addEventListener('input', (e) => this.h.onScrub(Number(e.target.value) / 1000));
  }

  _bindViewport() {
    const tabs = { 'tab-3d': 'show-3d', 'tab-2d': 'show-2d', 'tab-split': 'show-split' };
    for (const [id, cls] of Object.entries(tabs)) {
      $(id).addEventListener('click', () => {
        for (const [tid] of Object.entries(tabs)) $(tid).classList.toggle('active', tid === id);
        $('viewport').className = cls;
        this.h.onView(cls.replace('show-', ''));
      });
    }
    $('chk-paths').addEventListener('change', (e) => this.h.onToggle('paths', e.target.checked));
    $('chk-ghost').addEventListener('change', (e) => this.h.onToggle('ghost', e.target.checked));
    $('chk-p-rough').addEventListener('change', (e) => this.h.onToggle('rough', e.target.checked));
    $('chk-p-finish').addEventListener('change', (e) => this.h.onToggle('finish', e.target.checked));
    $('chk-p-rapid').addEventListener('change', (e) => this.h.onToggle('rapid', e.target.checked));
  }

  /** Master toolpath switch off → dim + disable the per-group path checkboxes. */
  setPathsEnabled(on) {
    for (const id of ['chk-p-rough', 'chk-p-finish', 'chk-p-rapid']) {
      const el = $(id);
      el.disabled = !on;
      el.closest('label').classList.toggle('dim', !on);
    }
  }

  // ---- playback state ------------------------------------------------------
  setPlaying(on) {
    this.playing = on;
    const b = $('btn-play');
    b.textContent = on ? '⏸' : '▶';
    b.classList.toggle('playing', on);
  }

  setScrub(frac) { $('sl-scrub').value = Math.round(frac * 1000); }

  setTime(elapsed, total) {
    $('lbl-time').textContent = `${fmtTime(elapsed)} / ${fmtTime(total)}`;
  }

  // ---- G-code terminal -------------------------------------------------------
  setGcode(lines) {
    const term = $('term');
    const frag = document.createDocumentFragment();
    this.termEls = [];
    for (const l of lines) {
      const div = document.createElement('div');
      let cls = 'ln';
      if (/^G1\b/.test(l.text)) cls += ' g1';
      else if (/^G0\b/.test(l.text)) cls += ' g0';
      else if (/^[(%]/.test(l.text)) cls += ' cm';
      div.className = cls;
      div.textContent = l.text;
      frag.appendChild(div);
      this.termEls.push(div);
    }
    term.textContent = '';
    term.appendChild(frag);
    this.hlIdx = -1;
  }

  highlightLine(i) {
    if (i === this.hlIdx) return;
    const els = this.termEls;
    if (this.hlIdx >= 0 && els[this.hlIdx]) els[this.hlIdx].classList.remove('hl');
    this.hlIdx = i;
    if (i >= 0 && i < els.length) {
      const el = els[i];
      el.classList.add('hl');
      const term = $('term');
      const top = el.offsetTop;
      if (top < term.scrollTop || top > term.scrollTop + term.clientHeight - 20) {
        term.scrollTop = top - term.clientHeight / 2;
      }
    }
  }

  // ---- readouts -----------------------------------------------------------
  dro(pose) {
    $('dro-x').textContent = pose.X.toFixed(1);
    $('dro-z').textContent = pose.Z.toFixed(1);
    $('dro-a').textContent = `${pose.A.toFixed(1)}°`;
    $('dro-f').textContent = String(Math.round(pose.F));
  }

  statsDisplay(stats) {
    $('lbl-nblocks').textContent = String(stats.nG1 + stats.nG0);
    $('lbl-cutdist').textContent = `${Math.round(stats.cutDist)} mm`;
    $('lbl-est').textContent = fmtTime(stats.estSeconds);
  }

  removed(cm3) { $('lbl-removed').textContent = `${cm3.toFixed(1)} cm³`; }

  status(msg, isError = false) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('err', isError);
  }

  /**
   * Persistent advisory line for static collision findings (M4). Separate
   * from #status so a later status message never hides a safety warning.
   * @param {object} analysis result of analyzeProgram()
   * @param {number} firstLine 1-based G-code terminal line of the first finding
   */
  collisionWarn(analysis, firstLine = 0) {
    const el = $('collide-warn');
    if (!el) return;
    if (!analysis || analysis.ok) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    const where = firstLine > 0 ? ` — first at line ${firstLine}, flagged red in 3D` : '';
    el.textContent = `⚠ Collision check: ${analysis.summary}${where}`;
  }
}
