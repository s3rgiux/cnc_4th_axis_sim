/**
 * mesh.js — the INVERSE of the whole app idea: take a real 3D model
 * (STL / OBJ triangle mesh) and "unroll" it onto the cylindrical design
 * plane, i.e. build the heightmap r(V, φ) that the 2D flat view shows.
 *
 *     3D mesh ──projectToCylinder──▶ heightmap (U,V) ──strategies──▶ X/Z/A
 *
 * Projection = cylindrical max-envelope ("shadow" of the mesh wrapped on a
 * cylinder around the model's longest axis): for every (V, φ) grid cell we
 * keep the largest mesh radius reaching that cell. That is exactly what a
 * turning-style subtractive process sees — you cannot carve an overhang or
 * an internal void out of round stock, only its outer envelope.
 *
 * The result plugs into the same design interface as profiles.js:
 * { targetRadius(u, v), profileRadius(v), minTarget(), meta }
 * so every strategy, the ghost, the 2D heatmap and the post-processor work
 * unchanged on imported geometry.
 *
 * DOM-free: safe to import from Node tests and generator scripts.
 */

// ---------------------------------------------------------------------------
// STL parsing (binary + ASCII, auto-detected)
// ---------------------------------------------------------------------------

/**
 * @param {ArrayBuffer|ArrayBufferView} data
 * @returns {{pos: Float32Array, count: number}} triangle soup, 9 floats/tri
 */
export function parseSTL(data) {
  const buf =
    data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

  const dv = new DataView(buf);
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  if (n > 0 && 84 + n * 50 === buf.byteLength) {
    // Binary STL: [normal ×3][v1 ×3][v2 ×3][v3 ×3][attr u16] per facet.
    const pos = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12; // skip the stored facet normal
      for (let k = 0; k < 9; k++) pos[t * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
    return { pos, count: n };
  }

  // ASCII STL.
  const text = new TextDecoder().decode(buf);
  if (!/^\s*solid/.test(text)) throw new Error('Not an STL file');
  const re = /vertex\s+([+-]?[\d.eE+-]+)\s+([+-]?[\d.eE+-]+)\s+([+-]?[\d.eE+-]+)/g;
  const verts = [];
  let m;
  while ((m = re.exec(text))) verts.push(+m[1], +m[2], +m[3]);
  if (!verts.length) throw new Error('ASCII STL contains no vertices');
  if (verts.length % 9) throw new Error('ASCII STL vertex count not a multiple of 3');
  return { pos: new Float32Array(verts), count: verts.length / 9 };
}

// ---------------------------------------------------------------------------
// OBJ parsing (v lines + polygon faces with v / v/vt / v//vn / v/vt/vn
// indices, negative indices supported; polygons fan-triangulated)
// ---------------------------------------------------------------------------
export function parseOBJ(text) {
  const vs = []; // flat x,y,z
  const faces = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      vs.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('f ')) {
      const idx = [];
      for (const tok of line.split(/\s+/).slice(1)) {
        const a = parseInt(tok.split('/')[0], 10);
        if (!isFinite(a)) continue;
        idx.push(a > 0 ? a - 1 : vs.length / 3 + a);
      }
      if (idx.length >= 3) faces.push(idx);
    }
  }
  const nv = vs.length / 3;
  const pos = new Float32Array(faces.length * 2 * 3); // worst-case count set below
  let w = 0;
  for (const f of faces) {
    for (let k = 2; k < f.length; k++) {
      for (const vi of [f[0], f[k - 1], f[k]]) {
        pos[w++] = vs[vi * 3] || 0;
        pos[w++] = vs[vi * 3 + 1] || 0;
        pos[w++] = vs[vi * 3 + 2] || 0;
      }
    }
  }
  if (!w) throw new Error('OBJ contains no faces');
  return { pos: pos.subarray(0, w), count: w / 9 };
}

// ---------------------------------------------------------------------------
// 3D → cylindrical heightmap ("unroll the model into the 2D map")
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

/**
 * Rasterize a triangle soup onto an (nx × nth) cylindrical heightmap.
 *
 * @param {Float32Array} pos   triangle soup (9 floats per triangle)
 * @param {number} count       triangle count
 * @param {{length:number, R0:number, nx:number, nth:number}} opts
 *        target stock length / radius and grid resolution (mm model units
 *        are fit-scaled into the stock: axis → length, radius → ≤ 0.98·R0)
 * @returns {{h: Float32Array, nx:number, nth:number, meta:object}}
 */
export function projectToCylinder(pos, count, opts) {
  const { length: L, R0, nx, nth } = opts;
  if (nx < 8 || nth < 16) throw new Error('grid too small');

  // Bounding box → choose the model axis = longest dimension.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      for (let c = 0; c < 3; c++) {
        const v = pos[t * 9 + k * 3 + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
  }
  let axis = 0;
  for (let c = 1; c < 3; c++) if (max[c] - min[c] > max[axis] - min[axis]) axis = c;
  const k1 = (axis + 1) % 3;
  const k2 = (axis + 2) % 3;
  const spanA = max[axis] - min[axis];
  if (spanA <= 0) throw new Error('degenerate mesh');
  // Axis position in the cross-section = vertex centroid (≈ the lathe axis
  // for any closed ring stack; a bbox centre would drift on asymmetric
  // silhouettes and warp the φ mapping).
  let s1 = 0, s2 = 0, n3 = count * 3;
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) { s1 += pos[t * 9 + k * 3 + k1]; s2 += pos[t * 9 + k * 3 + k2]; }
  }
  const c1 = s1 / n3;
  const c2 = s2 / n3;
  const sv = L / spanA;
  let radMax = 0;
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const dx = pos[t * 9 + k * 3 + k1] - c1;
      const dy = pos[t * 9 + k * 3 + k2] - c2;
      radMax = Math.max(radMax, Math.hypot(dx, dy));
    }
  }
  if (radMax <= 0) throw new Error('flat mesh');
  const sr = (0.98 * R0) / radMax;

  const dx = L / (nx - 1);
  const dTheta = TAU / nth;
  const h = new Float32Array(nx * nth).fill(-1); // -1 = untouched

  const splat = (fi, fj, r) => {
    const i = fi | 0;
    if (i < 0 || i >= nx) return;
    let j = Math.floor(fj) % nth;
    if (j < 0) j += nth;
    const k = i * nth + j;
    if (r > h[k]) h[k] = r;
  };

  // One vertex of a projected triangle: (fi, fj, r) with φ unwrapped around
  // the widest vertex; near-axis vertices (cap fans) take the mean fj of the
  // other two — atan2 at r≈0 is meaningless.
  const prep = (tri) => {
    let rRef = -1;
    let iRef = 0;
    for (let k = 0; k < 3; k++) if (tri[k].r > rRef) { rRef = tri[k].r; iRef = k; }
    const ref = tri[iRef].phi;
    for (let k = 0; k < 3; k++) {
      const p = tri[k];
      if (k === iRef || p.r >= 1e-4) {
        let a = p.phi;
        while (a - ref > Math.PI) a -= TAU;
        while (ref - a > Math.PI) a += TAU;
        p.fj = (a / TAU) * nth;
      }
    }
    for (let k = 0; k < 3; k++) {
      const p = tri[k];
      if (p.r < 1e-4 && k !== iRef) p.fj = (tri[(k + 1) % 3].fj + tri[(k + 2) % 3].fj) / 2;
    }
    // NOTE: fj stays unwrapped (may be < 0 or ≥ nth across the seam); splat
    // wraps the index, and keeping continuity here avoids bogus rasters.
  };

  const raster = (a, b, c, depth) => {
    const fiMin = Math.min(a.fi, b.fi, c.fi), fiMax = Math.max(a.fi, b.fi, c.fi);
    const fjMin = Math.min(a.fj, b.fj, c.fj), fjMax = Math.max(a.fj, b.fj, c.fj);
    // Split huge spans so thin curved features cannot slip between samples.
    if (depth > 0 && (fiMax - fiMin > 20 || fjMax - fjMin > 20)) {
      const mid = (p, q) => ({
        fi: (p.fi + q.fi) / 2, fj: (p.fj + q.fj) / 2, r: (p.r + q.r) / 2, phi: 0,
      });
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      raster(a, ab, ca, depth - 1); raster(ab, b, bc, depth - 1);
      raster(ca, bc, c, depth - 1); raster(ab, bc, ca, depth - 1);
      return;
    }
    // Vertex splats keep sliver triangles from disappearing entirely.
    splat(a.fi, a.fj, a.r); splat(b.fi, b.fj, b.r); splat(c.fi, c.fj, c.r);
    const den = (b.fj - c.fj) * (a.fi - c.fi) + (c.fi - b.fi) * (a.fj - c.fj);
    if (Math.abs(den) < 1e-12) return;
    const i0 = Math.max(0, Math.floor(fiMin)), i1 = Math.min(nx - 1, Math.ceil(fiMax));
    const j0 = Math.floor(fjMin), j1 = Math.ceil(fjMax);
    for (let i = i0; i <= i1; i++) {
      for (let jj = j0; jj <= j1; jj++) {
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const px = i + (sx + 0.5) / 2;
            const py = jj + (sy + 0.5) / 2;
            const wa = ((b.fj - c.fj) * (px - c.fi) + (c.fi - b.fi) * (py - c.fj)) / den;
            const wb = ((c.fj - a.fj) * (px - c.fi) + (a.fi - c.fi) * (py - c.fj)) / den;
            const wc = 1 - wa - wb;
            if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
            splat(i, jj, wa * a.r + wb * b.r + wc * c.r);
          }
        }
      }
    }
  };

  const tri = [
    { fi: 0, fj: 0, r: 0, phi: 0 }, { fi: 0, fj: 0, r: 0, phi: 0 }, { fi: 0, fj: 0, r: 0, phi: 0 },
  ];
  let filled = 0;
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      tri[k].fi = ((pos[o + axis] - min[axis]) * sv) / dx;
      tri[k].phi = Math.atan2(pos[o + k2] - c2, pos[o + k1] - c1);
      tri[k].r = Math.hypot(pos[o + k1] - c1, pos[o + k2] - c2) * sr;
    }
    prep(tri);
    raster(tri[0], tri[1], tri[2], 3);
  }

  // Fill untouched cells per row by circular interpolation along φ,
  // then smooth once around the circumference and once along V.
  for (let i = 0; i < nx; i++) {
    const row = i * nth;
    let nFill = 0;
    for (let j = 0; j < nth; j++) if (h[row + j] >= 0) nFill++;
    if (nFill === 0) { for (let j = 0; j < nth; j++) h[row + j] = 0; continue; }
    filled += nFill;
    let start = 0;
    while (h[row + start] < 0) start++;
    let j = start;
    for (let guard = 0; guard < nth; guard++) {
      if (h[row + (j + 1) % nth] < 0) {
        let d = 2;
        while (h[row + (j + d) % nth] < 0) d++;
        const a = h[row + j % nth], b = h[row + (j + d) % nth];
        for (let k = 1; k < d; k++) h[row + (j + k) % nth] = a + ((b - a) * k) / d;
        j += d;
        guard += d - 1;
      } else j++;
    }
  }
  const tmp = new Float32Array(nx * nth);
  // Pass 1: smooth around the circumference (wrap-aware).
  for (let i = 0; i < nx; i++) {
    const row = i * nth;
    for (let j = 0; j < nth; j++) {
      tmp[row + j] =
        0.25 * h[row + (j + nth - 1) % nth] + 0.5 * h[row + j] + 0.25 * h[row + (j + 1) % nth];
    }
  }
  h.set(tmp);
  // Pass 2: smooth along V (clamped ends).
  for (let i = 0; i < nx; i++) {
    const row = i * nth;
    const ip = Math.max(0, i - 1) * nth;
    const inx = Math.min(nx - 1, i + 1) * nth;
    for (let j = 0; j < nth; j++) {
      tmp[row + j] = 0.25 * h[ip + j] + 0.5 * h[row + j] + 0.25 * h[inx + j];
    }
  }
  h.set(tmp);

  return {
    h, nx, nth,
    meta: {
      axis: 'xyz'[axis],
      sizeMm: [+spanA.toFixed(1), +(max[k1] - min[k1]).toFixed(1), +(max[k2] - min[k2]).toFixed(1)],
      scaleAxis: +sv.toFixed(4),
      scaleRadius: +sr.toFixed(4),
      coverage: +(filled / (nx * nth)).toFixed(3),
    },
  };
}

// ---------------------------------------------------------------------------
// Design adapter: heightmap → the same interface profiles.js returns
// ---------------------------------------------------------------------------

/**
 * @param {{h: Float32Array, nx:number, nth:number, meta:object}} proj
 * @param {number} L   current stock length (mm)
 * @param {number} R0  current stock radius (mm)
 * @param {string} name display name
 */
export function makeHeightmapDesign(proj, L, R0, name) {
  const { h, nx, nth } = proj;
  const floorR = 0.02 * R0; // never demand an exact axis point

  function sample(t, u01) {
    let fi = t * (nx - 1);
    if (fi < 0) fi = 0; else if (fi > nx - 1) fi = nx - 1;
    const i0 = Math.floor(fi);
    const i1 = Math.min(nx - 1, i0 + 1);
    const wi = fi - i0;
    let fj = (u01 - Math.floor(u01)) * nth;
    const j0 = Math.floor(fj) % nth;
    const j1 = (j0 + 1) % nth;
    const wj = fj - Math.floor(fj);
    const a = h[i0 * nth + j0], b = h[i0 * nth + j1];
    const c = h[i1 * nth + j0], d = h[i1 * nth + j1];
    return Math.max((a * (1 - wj) + b * wj) * (1 - wi) + (c * (1 - wj) + d * wj) * wi, floorR);
  }

  let minT = Infinity;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nth; j++) minT = Math.min(minT, h[i * nth + j]);
  }

  return {
    /** u = arc length along the unrolled map (θ·R0), v = axial position. */
    targetRadius(u, v) {
      return sample(v / L, u / (TAU * R0));
    },
    profileRadius(v) {
      let fi = (v / L) * (nx - 1);
      fi = fi < 0 ? 0 : Math.min(nx - 1, fi);
      const i0 = Math.floor(fi), wi = fi - i0, i1 = Math.min(nx - 1, i0 + 1);
      let m = 0;
      for (let j = 0; j < nth; j++) m = Math.max(m, h[i0 * nth + j] * (1 - wi) + h[i1 * nth + j] * wi);
      return m;
    },
    minTarget: () => Math.max(minT, floorR),
    meta: { name: `imported:${name}`, imported: true },
  };
}
