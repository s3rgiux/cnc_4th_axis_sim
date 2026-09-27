/**
 * sim.js — playback engine driving the synchronized animation.
 *
 * The program is treated as one continuous polyline in machine space; the
 * simulator advances a "distance travelled by the TCP" clock at the feed rate
 * of whatever segment is currently active, scaled by the speed multiplier.
 * Stock removal is applied in small sub-steps so that even at 50× speed the
 * heightmap sees every fraction of a tool radius.
 *
 * Seeking backwards (scrub / step-back) re-simulates from scratch with cuts
 * applied but no rendering callbacks — for typical programs this is ~10ms.
 *
 * DOM-free.
 */
import { moveDistance } from '../core/unroll.js';

export class Simulator {
  /**
   * @param {object} stock  CylindricalStock
   * @param {object} tool   { type, diameter } — used for cut footprint
   * @param {object} feeds  { rough, finish, rapid }
   * @param {number} substep max mm per cutAt() application
   */
  constructor(stock, tool, feeds, substep = 0.45) {
    this.stock = stock;
    this.tool = { R: Math.max(tool.diameter / 2, 0.01), ball: tool.type === 'ball' };
    this.feeds = feeds;
    this.substep = substep;
    this.onUpdate = null; // (pose, segIdx) => void — survives reloads
    this.load(null);
  }

  setTool(tool) {
    this.tool = { R: Math.max(tool.diameter / 2, 0.01), ball: tool.type === 'ball' };
  }

  load(program) {
    this.prog = program;
    this.segs = program ? program.segments : [];
    const n = this.segs.length;
    this.cumDist = new Float64Array(n);
    this.cumTime = new Float64Array(n); // seconds at 1× speed
    const h = this.home();
    let d = 0, t = 0;
    let px = h.X, pz = h.Z, pa = h.A;
    for (let i = 0; i < n; i++) {
      const s = this.segs[i];
      const len = moveDistance(px, pz, pa, s.X, s.Z, s.A);
      const feed = s.mode === 'G1' ? Math.max(s.F, 1) : Math.max(this.feeds.rapid, 1);
      d += len; t += (len / feed) * 60;
      this.cumDist[i] = d;
      this.cumTime[i] = t;
      px = s.X; pz = s.Z; pa = s.A;
    }
    this.totalDist = d;
    this.totalSeconds = t;
    this.dist = 0;
    this.curSeg = -1;
    this.pose = { ...h, F: 0, mode: 'G0', cutting: false };
  }

  home() {
    const first = this.segs[0];
    return { X: 0, Z: first ? first.Z : 0, A: 0 };
  }

  /** Interpolated pose at a path distance (does not mutate state). */
  poseAt(dist) {
    const segs = this.segs;
    if (!segs.length) return { ...this.home(), F: 0, mode: 'G0', cutting: false };
    const d = Math.min(Math.max(dist, 0), this.totalDist);
    // Linear scan from cached index is fine; programs are ordered playback.
    let i = 0;
    while (i < segs.length - 1 && this.cumDist[i] < d) i++;
    const prevD = i === 0 ? 0 : this.cumDist[i - 1];
    const len = this.cumDist[i] - prevD;
    const s = segs[i];
    const t = len > 1e-9 ? (d - prevD) / len : 1;
    const p0 = i === 0 ? this.home() : segs[i - 1];
    return {
      X: p0.X + (s.X - p0.X) * t,
      Z: p0.Z + (s.Z - p0.Z) * t,
      A: p0.A + (s.A - p0.A) * t,
      F: s.mode === 'G1' ? s.F : this.feeds.rapid,
      mode: s.mode,
      cutting: s.mode === 'G1',
      _seg: i,
    };
  }

  /** Feed rate governing motion at the current position (mm/min). */
  feedAt(pose = this.pose) {
    return pose.mode === 'G1' ? Math.max(pose.F, 1) : Math.max(this.feeds.rapid, 1);
  }

  /**
   * Advance playback by deltaDist (mm). Applies cuts for every sub-step on
   * G1 spans. Returns true when the program end is reached.
   */
  advance(deltaDist) {
    if (!this.segs.length || this.dist >= this.totalDist) return true;
    const from = this.dist;
    const to = Math.min(this.dist + Math.max(deltaDist, 0), this.totalDist);
    this._applyRun(from, to);
    this.dist = to;
    this.pose = this.poseAt(to);
    this.curSeg = this.pose._seg ?? -1;
    if (this.onUpdate) this.onUpdate(this.pose, this.curSeg);
    return this.dist >= this.totalDist;
  }

  /** Jump to an absolute path distance (resimulating if going backwards). */
  advanceTo(dist) {
    const d = Math.min(Math.max(dist, 0), this.totalDist);
    if (d < this.dist) {
      this.stock.reset();
      this.dist = 0;
      this._applyRun(0, d);
    } else {
      this._applyRun(this.dist, d);
    }
    this.dist = d;
    this.pose = this.poseAt(d);
    this.curSeg = this.pose._seg ?? -1;
    if (this.onUpdate) this.onUpdate(this.pose, this.curSeg);
  }

  /**
   * Walk (from, to] in sub-steps applying stock cuts where the segment is a
   * G1 feed move.
   */
  _applyRun(from, to) {
    if (to <= from) return;
    const step = this.substep;
    for (let d = from; d < to; ) {
      const dEnd = Math.min(d + step, to);
      const p = this.poseAt(dEnd);
      if (p.cutting) this.stock.cutAt(p.X, p.Z, p.A, this.tool);
      d = dEnd;
    }
  }

  // ---- transport helpers ---------------------------------------------------

  /** Distance at the end of segment index i. */
  segEnd(i) {
    return this.cumDist[Math.min(Math.max(i, 0), this.segs.length - 1)];
  }

  stepNext() {
    // Advance to the end of the next G1 segment (skips over rapids between).
    let i = this.curSeg + 1;
    while (i < this.segs.length && this.segs[i].mode !== 'G1') i++;
    if (i >= this.segs.length) i = this.segs.length - 1;
    this.advanceTo(this.cumDist[i]);
  }

  stepPrev() {
    // Back up to the start of the current (or previous) G1 segment.
    let i = this.curSeg;
    if (i < 0) { this.advanceTo(0); return; }
    if (this.segs[i].mode !== 'G1') { // mid-rapid: just back up one block
      this.advanceTo(i === 0 ? 0 : this.cumDist[i - 1]);
      return;
    }
    const startD = i === 0 ? 0 : this.cumDist[i - 1];
    // If we're just past a segment end, step to the previous G1's start.
    if (Math.abs(this.dist - this.cumDist[i]) < 1e-6) {
      let k = i - 1;
      while (k >= 0 && this.segs[k].mode !== 'G1') k--;
      this.advanceTo(k <= 0 ? 0 : this.cumDist[k - 1]);
    } else {
      this.advanceTo(startD);
    }
  }

  reset() {
    this.stock.reset();
    this.dist = 0;
    this.curSeg = -1;
    this.pose = { ...this.home(), F: 0, mode: 'G0', cutting: false };
    if (this.onUpdate) this.onUpdate(this.pose, this.curSeg);
  }

  get progress() {
    return this.totalDist > 0 ? this.dist / this.totalDist : 0;
  }

  setProgress(frac) {
    this.advanceTo(this.totalDist * Math.min(Math.max(frac, 0), 1));
  }

  /** Elapsed machining seconds at the current position (independent of ×). */
  elapsedSeconds() {
    return this.curSeg < 0 ? 0 : this.cumTime[this.curSeg];
  }
}
