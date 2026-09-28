/**
 * view2d.js — the "Unrolled 2D Flat View".
 *
 * Renders the live material state of the cylindrical heightmap directly onto
 * the (U, V) design plane: horizontal = circumference (0 → 2πR₀), vertical =
 * axial length. Because the stock model IS this map, the 2D viewport is a
 * second projection of the same buffer — watch flute grooves appear as diagonal
 * bands while the helix plays in 3D.
 *
 * Layers: removal heatmap → on-target tint → toolpath lines (rapid / rough /
 * finish) → live tool crosshair → mm/deg rulers. Click-to-seek supported.
 */
import { uFromA, circumference } from '../core/unroll.js';

const MARGIN_L = 46, MARGIN_T = 26, MARGIN_R = 10, MARGIN_B = 22;

export class View2D {
  constructor(wrapEl) {
    this.wrap = wrapEl;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:crosshair';
    wrapEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.img = document.createElement('canvas');
    this.imgCtx = this.img.getContext('2d');

    // program map-space caches
    this.pathLines = { rapid: [], rough: [], finish: [], detail: [] }; // flat [u0,v0,u1,v1,...]
    // Path-layer visibility mirrors the overlay checkboxes (rapids off by default).
    this.pathVisible = { rapid: false, rough: true, finish: true, detail: true };
    // Design-contour ghost (2D counterpart of view3D's target ghost).
    this.ghostVisible = true;
    this.ghostContours = [];
    // Simulated residue layer (core/residue.js): red = gouge, blue = rest.
    this.residue = null;
    this.residueVisible = true;
    this.resImg = document.createElement('canvas');
    this.resCtx = this.resImg.getContext('2d');
    this.seekPts = null; // Float64Array triples (dist, u, v)
    this.R0 = 25; this.L = 200;
    this._toolR = 3;
    this.onSeek = null;
    this.stock = null;
    this.targetGrid = null;

    this.canvas.addEventListener('pointerdown', (e) => {
      const d = this.seekAt(e);
      if (d != null && this.onSeek) this.onSeek(d);
    });
  }

  /** (Re)cache program geometry in map space. cumDist = simulator cumulative distances. */
  setProgram(stock, design, program, cumDist) {
    this.stock = stock;
    this.R0 = stock.R0;
    this.L = stock.length;
    const { nx, nth } = stock;

    // Pre-compute target radius per cell (pattern is stock-locked: U = φ·R0).
    this.targetGrid = new Float32Array(nx * nth);
    for (let i = 0; i < nx; i++) {
      const v = stock.xs[i];
      for (let j = 0; j < nth; j++) {
        this.targetGrid[i * nth + j] = design.targetRadius((j / nth) * 2 * Math.PI * this.R0, v);
      }
    }
    // Design-preview layer: iso-radius contours of the unrolled target,
    // revealed/hidden with the "target ghost" checkbox (like view3D's ghost).
    this.ghostContours = this._buildContours(this.targetGrid, nx, nth);

    // Path polylines + seek samples (dist, u, v triples).
    this.pathLines = { rapid: [], rough: [], finish: [], detail: [] };
    const seek = [];
    let prevU = 0, prevV = 0;
    program.segments.forEach((s, i) => {
      const u = uFromA(s.A, this.R0);
      const v = s.X;
      const key = s.mode === 'G0' ? 'rapid' : s.group;
      const gk = key === 'rough' || key === 'finish' || key === 'detail' ? key : 'rapid';
      this.pathLines[gk].push(prevU, prevV, u, v);
      if (cumDist) seek.push(cumDist[i], u, v);
      prevU = u; prevV = v;
    });
    this.seekPts = seek.length ? Float64Array.from(seek) : null;

    this.img.width = nth;
    this.img.height = nx;
  }

  /** Nearest toolpath distance to a click position (mm along the path). */
  seekAt(evt) {
    if (!this.seekPts) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = evt.clientX - rect.left, py = rect.clientY - rect.top;
    const { mx, my, mw, mh } = this._mapRect(rect.width, rect.height);
    if (px < mx || px > mx + mw || py < my || py > my + mh) return null;
    const circ = circumference(this.R0);
    const u = ((px - mx) / mw) * circ;
    const v = ((py - my) / mh) * this.L;
    let best = -1, bestD = 14; // px tolerance
    for (let i = 0; i < this.seekPts.length; i += 3) {
      const du = (this.seekPts[i + 1] - u) / circ * mw;
      const dv = (this.seekPts[i + 2] - v) / this.L * mh;
      const d = Math.hypot(du, dv);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? this.seekPts[best] : null;
  }

  _mapRect(w, h) {
    return {
      mx: MARGIN_L, my: MARGIN_T,
      mw: Math.max(10, w - MARGIN_L - MARGIN_R),
      mh: Math.max(10, h - MARGIN_T - MARGIN_B),
    };
  }

  setGhostVisible(v) { this.ghostVisible = v; }
  setResidueVisible(v) { this.residueVisible = v; }

  /** Cache the residue diff as an RGBA layer (null clears it). */
  setResidue(res) {
    this.residue = res;
    if (!res) return;
    const { nx, nth, diff, tol } = res;
    this.resImg.width = nth;
    this.resImg.height = nx;
    const id = this.resCtx.createImageData(nth, nx);
    const d = id.data;
    const full = 1.0; // mm of deviation that saturates the tint
    for (let c = 0; c < nx * nth; c++) {
      const v = diff[c];
      const p = c * 4;
      if (v < -tol) {          // gouge: red
        d[p] = 255; d[p + 1] = 48; d[p + 2] = 64;
        d[p + 3] = Math.round(90 + 150 * Math.min(1, (-v - tol) / full));
      } else if (v > tol) {    // rest material: blue
        d[p] = 70; d[p + 1] = 130; d[p + 2] = 255;
        d[p + 3] = Math.round(60 + 140 * Math.min(1, (v - tol) / full));
      } else {
        d[p + 3] = 0;
      }
    }
    this.resCtx.putImageData(id, 0, 0);
  }

  /** Marching-squares iso-contours of a target grid → flat [u0,v0,u1,v1,…].
   *  Gives the 2D map a "design blueprint" layer showing what the finished
   *  part looks like unrolled, before any material has been cut. */
  _buildContours(g, nx, nth) {
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < g.length; c++) { if (g[c] < lo) lo = g[c]; if (g[c] > hi) hi = g[c]; }
    const out = [];
    if (!(hi - lo > 0.6)) return out; // essentially uniform design → nothing to draw
    const circ = 2 * Math.PI * this.R0;
    const LEVELS = 8;
    for (let k = 1; k <= LEVELS; k++) {
      const lv = lo + ((hi - lo) * k) / (LEVELS + 1);
      for (let i = 0; i < nx - 1; i++) {
        for (let j = 0; j < nth; j++) {
          const j2 = (j + 1) % nth; // φ index wraps; φ coord stays unwrapped below
          const a = g[i * nth + j], b = g[(i + 1) * nth + j];
          const c = g[(i + 1) * nth + j2], d = g[i * nth + j2];
          const e = []; // crossings on cell edges AB, BC, CD, DA (in order)
          if ((a - lv) * (b - lv) < 0) e.push([i + (lv - a) / (b - a), j]);
          if ((b - lv) * (c - lv) < 0) e.push([i + 1, j + (lv - b) / (c - b)]);
          if ((c - lv) * (d - lv) < 0) e.push([i + 1 - (lv - d) / (c - d), j + 1]);
          if ((d - lv) * (a - lv) < 0) e.push([i, j + 1 - (lv - a) / (d - a)]);
          if (e.length === 2 || e.length === 4) {
            out.push(e[0][0] / nth * circ, e[0][1] / (nx - 1) * this.L,
                     e[1][0] / nth * circ, e[1][1] / (nx - 1) * this.L);
            if (e.length === 4) out.push(e[2][0] / nth * circ, e[2][1] / (nx - 1) * this.L,
                                         e[3][0] / nth * circ, e[3][1] / (nx - 1) * this.L);
          }
        }
      }
    }
    return out;
  }

  /** Full redraw. Called once per animation frame while visible. */
  draw(pose) {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.wrap.clientWidth || 1, h = this.wrap.clientHeight || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
    if (!this.stock) return;

    const { nx, nth, radii, R0 } = this.stock;
    const circ = circumference(R0);
    const { mx, my, mw, mh } = this._mapRect(w, h);

    // ---- heatmap into tiny ImageData, then smooth-scale --------------------
    const id = this.imgCtx.createImageData(nth, nx);
    const data = id.data;
    const onTargetTol = 0.5;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nth; j++) {
        const c = i * nth + j;
        const r = radii[c];
        let cr, cg, cb;
        if (r >= R0 - 0.01) {
          cr = 118; cg = 80; cb = 48; // untouched wood
        } else {
          const t = Math.min(1, (R0 - r) / (0.85 * R0));
          if (t < 0.5) {
            const k = t * 2;
            cr = 24 + k * 8; cg = 74 + k * 100; cb = 140 + k * 12;
          } else {
            const k = (t - 0.5) * 2;
            cr = 32 + k * 200; cg = 174 + k * 28; cb = 152 - k * 70;
          }
          const rt = this.targetGrid[c];
          if (Math.abs(r - rt) < onTargetTol) {
            cr = cr * 0.35 + 40; cg = cg * 0.35 + 190; cb = cb * 0.35 + 110; // green: on target
          }
        }
        const p = c * 4;
        data[p] = cr; data[p + 1] = cg; data[p + 2] = cb; data[p + 3] = 255;
      }
    }
    this.imgCtx.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.img, 0, 0, nth, nx, mx, my, mw, mh);
    if (this.residue && this.residueVisible && this.residue.nx === nx && this.residue.nth === nth) {
      ctx.drawImage(this.resImg, 0, 0, nth, nx, mx, my, mw, mh);
    }
    ctx.strokeStyle = '#2a3547';
    ctx.strokeRect(mx, my, mw, mh);

    // ---- toolpath overlays --------------------------------------------------
    const toPx = (u, v) => [mx + (u / circ) * mw, my + (v / this.L) * mh];
    const strokeGroup = (pts, color, width, dash) => {
      if (!pts.length) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 4) {
        // Draw each little segment; adjacent segments share points so no need
        // for moveTo bookkeeping beyond the wrap seam.
        const [x0, y0] = toPx(pts[i], pts[i + 1]);
        const [x1, y1] = toPx(pts[i + 2], pts[i + 3]);
        if (Math.abs(pts[i + 2] - pts[i]) > circ * 0.5 || Math.abs(pts[i + 3] - pts[i + 1]) > this.L * 0.5) continue;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (this.ghostVisible) strokeGroup(this.ghostContours, 'rgba(150,185,235,0.8)', 1.25);
    if (this.pathVisible.rapid) strokeGroup(this.pathLines.rapid, 'rgba(224,138,60,0.45)', 1, [3, 3]);
    if (this.pathVisible.rough) strokeGroup(this.pathLines.rough, 'rgba(45,212,191,0.8)', 1);
    if (this.pathVisible.finish) strokeGroup(this.pathLines.finish, 'rgba(74,222,128,0.9)', 1.2);
    if (this.pathVisible.detail) strokeGroup(this.pathLines.detail, 'rgba(192,132,252,0.85)', 1);

    // ---- live cursor ---------------------------------------------------------
    if (pose) {
      const cu = uFromA(pose.A, R0);
      const [cx, cy] = toPx(cu, pose.X);
      const rx = (this._toolR / circ) * mw; // tool footprint ellipse (axial R wide)
      ctx.strokeStyle = pose.cutting ? '#facc15' : '#e2e8f0';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(3, rx), 0, Math.PI * 2);
      ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy);
      ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9);
      ctx.stroke();
    }

    // ---- rulers ---------------------------------------------------------------
    ctx.fillStyle = '#8b98ab';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let deg = 0; deg <= 360; deg += 90) {
      const x = mx + (deg / 360) * mw;
      ctx.fillText(`${deg}°`, x, my - 6);
      ctx.fillRect(x - 0.5, my, 1, 4);
    }
    ctx.textAlign = 'right';
    for (let mm = 0; mm <= this.L; mm += 25) {
      const y = my + (mm / this.L) * mh;
      ctx.fillText(`${mm}`, mx - 6, y + 3);
      ctx.fillRect(mx, y - 0.5, 4, 1);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#66738a';
    ctx.fillText('U → circumference (A+) · V ↓ length (X)', mx, h - 7);
  }

  setToolRadius(mm) { this._toolR = Math.max(mm, 0.5); }
}
