/**
 * contour.js — chained iso-contours of a cylindrical heightmap grid.
 *
 * Marching squares over an nx × nth grid whose second index wraps (the
 * circumference), with the per-cell crossings CHAINED into polylines by
 * shared cell edges, so a contour can be machined as one continuous move
 * rather than drawn as a soup of unrelated dashes (which is all the 2D ghost
 * layer needs). Output coordinates are fractional grid indices (fi, fj) with
 * fj UNWRAPPED: a ring around the part runs fj from ~0 to ~nth continuously.
 *
 * DOM-free.
 */

/**
 * @param {Float32Array|number[]} g   heights, g[i*nth + j]
 * @param {number} nx   axial samples (open ends)
 * @param {number} nth  angular samples (wrapped)
 * @param {number} lv   iso level
 * @returns {Array<{closed:boolean, pts:Array<[number,number]>}>}
 */
export function isoContours(g, nx, nth, lv) {
  // Edge keys: H(i,j) = edge along φ from (i,j) to (i,j+1); V(i,j) = edge along
  // x from (i,j) to (i+1,j). Crossing position stored per key.
  const hKey = (i, j) => i * nth + j;               // 0 .. nx*nth-1
  const vKey = (i, j) => nx * nth + i * nth + j;    // offset block
  const pos = new Map();   // key → [fi, fj(wrapped in [0,nth))]
  const adj = new Map();   // key → [otherKey, ...]
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  };
  const cross = (v0, v1) => (lv - v0) / (v1 - v0);

  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < nth; j++) {
      const j2 = (j + 1) % nth;
      const a = g[i * nth + j], b = g[(i + 1) * nth + j];
      const c = g[(i + 1) * nth + j2], d = g[i * nth + j2];
      const e = []; // [key, fi, fj] on edges AB (V i,j), BC (H i+1,j), CD (V i,j+1), DA (H i,j)
      if ((a - lv) * (b - lv) < 0) { const k = vKey(i, j); e.push(k); pos.set(k, [i + cross(a, b), j]); }
      if ((b - lv) * (c - lv) < 0) { const k = hKey(i + 1, j); e.push(k); pos.set(k, [i + 1, j + cross(b, c)]); }
      if ((c - lv) * (d - lv) < 0) { const k = vKey(i, j2); e.push(k); pos.set(k, [i + cross(d, c), j + 1]); }
      if ((d - lv) * (a - lv) < 0) { const k = hKey(i, j); e.push(k); pos.set(k, [i, j + cross(a, d)]); }
      if (e.length === 2) link(e[0], e[1]);
      else if (e.length === 4) {
        // Saddle: pair by the cell-centre value so the two strands don't cross.
        const centre = 0.25 * (a + b + c + d);
        if ((centre - lv) * (a - lv) > 0) { link(e[0], e[3]); link(e[1], e[2]); }
        else { link(e[0], e[1]); link(e[2], e[3]); }
      }
    }
  }

  // Walk chains. Open chains start at degree-1 keys; the rest are closed loops.
  const seen = new Set();
  const out = [];
  const walk = (start) => {
    const pts = [];
    let prev = -1, cur = start, fjAcc = null;
    for (;;) {
      seen.add(cur);
      const p = pos.get(cur);
      let fj = p[1];
      if (fjAcc == null) fjAcc = fj;
      else {
        let dj = fj - (fjAcc % nth + nth) % nth;  // unwrap by shortest delta
        if (dj > nth / 2) dj -= nth; else if (dj < -nth / 2) dj += nth;
        fjAcc += dj;
      }
      pts.push([p[0], fjAcc]);
      const nb = adj.get(cur) || [];
      let next = -1;
      for (const k of nb) if (k !== prev && !seen.has(k)) { next = k; break; }
      if (next < 0) {
        // Closed loop returns to start?
        const closed = nb.includes(start) && pts.length > 2;
        return { closed, pts };
      }
      prev = cur; cur = next;
    }
  };
  for (const [k, nb] of adj) if (nb.length === 1 && !seen.has(k)) out.push(walk(k));
  for (const k of adj.keys()) if (!seen.has(k)) out.push(walk(k));
  return out;
}

/**
 * Slope magnitude (dimensionless, tan of the surface angle) of a cylindrical
 * heightmap at every cell, from central differences; φ spacing measured at the
 * local radius so a 45° wall reads 1 in either direction.
 */
export function slopeGrid(g, nx, nth, dx, dTheta) {
  const s = new Float32Array(nx * nth);
  for (let i = 0; i < nx; i++) {
    const im = Math.max(0, i - 1), ip = Math.min(nx - 1, i + 1);
    for (let j = 0; j < nth; j++) {
      const jm = (j + nth - 1) % nth, jp = (j + 1) % nth;
      const r = Math.max(g[i * nth + j], 1e-3);
      const gx = (g[ip * nth + j] - g[im * nth + j]) / ((ip - im) * dx);
      const gp = (g[i * nth + jp] - g[i * nth + jm]) / (2 * dTheta * r);
      s[i * nth + j] = Math.hypot(gx, gp);
    }
  }
  return s;
}
