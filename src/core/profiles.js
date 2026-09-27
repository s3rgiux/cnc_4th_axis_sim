/**
 * profiles.js — the cylindrical "design library".
 *
 * A part design is defined on the UNROLLED 2D map as:
 *
 *     r_target(U, V) = profile(V) · R0 − pattern(U, V) · R0 · depthScale
 *
 * - profile(V): the axisymmetric turning profile (table-leg silhouette),
 *   stored as control points [t, rRatio] with t = V/L ∈ [0,1] and rRatio the
 *   radius as a fraction of the raw stock radius. Interpolated with monotone
 *   cubic Hermite so beads/coins never overshoot.
 * - pattern(U, V): a decorative depth field carved into the surface. On the
 *   unrolled map spiral flutes are simple diagonal sine ridges — the whole
 *   point of planning in 2D and re-mapping to 3D.
 *
 * DOM-free: safe to import from Node tests.
 */

// ---------------------------------------------------------------------------
// Turning profile presets. t = 0 is the headstock end, t = 1 the free end.
// ---------------------------------------------------------------------------
export const PROFILES = [
  {
    id: 'cylinder',
    name: 'Plain Cylinder',
    points: [[0, 1], [1, 1]],
  },
  {
    id: 'taper',
    name: 'Straight Taper',
    points: [[0, 1], [0.1, 0.97], [0.9, 0.55], [1, 0.62]],
  },
  {
    id: 'classic-leg',
    name: 'Classic Turned Leg',
    points: [
      [0, 0.98], [0.08, 0.88], [0.32, 0.76], [0.40, 0.72],
      [0.47, 0.96], [0.53, 1.0], [0.60, 0.66], [0.68, 0.58],
      [0.82, 0.55], [0.89, 0.55], [0.94, 0.74], [1, 0.46],
    ],
  },
  {
    id: 'cove-ring',
    name: 'Bead · Cove · Ring',
    points: [
      [0, 0.9], [0.12, 0.9], [0.18, 1.0], [0.28, 0.7], [0.5, 0.68],
      [0.62, 0.98], [0.7, 1.0], [0.78, 0.8], [1, 0.8],
    ],
  },
  {
    id: 'well-leg',
    name: 'Well / Table Leg',
    points: [
      [0, 1.0], [0.25, 0.92], [0.35, 0.7], [0.42, 0.66], [0.5, 0.95],
      [0.56, 1.0], [0.64, 0.6], [0.78, 0.5], [0.9, 0.48], [0.96, 0.62], [1, 0.4],
    ],
  },
  {
    id: 'baseball-bat',
    name: 'Baseball Bat',
    points: [
      [0, 0.34], [0.035, 0.38], [0.06, 0.18], [0.12, 0.16], [0.38, 0.19],
      [0.58, 0.32], [0.70, 0.56], [0.80, 0.82], [0.88, 0.95], [0.95, 0.98],
      [0.985, 0.92], [1, 0.72],
    ],
  },
  {
    id: 'chess-pawn',
    name: 'Chess Pawn',
    points: [
      [0, 0.82], [0.06, 0.74], [0.13, 0.32], [0.35, 0.20], [0.55, 0.26],
      [0.62, 0.52], [0.67, 0.46], [0.71, 0.27], [0.75, 0.40], [0.83, 0.72],
      [0.89, 0.75], [0.95, 0.58], [1, 0.26],
    ],
  },
  {
    id: 'bottle',
    name: 'Bottle / Vase',
    points: [
      [0, 0.60], [0.03, 0.80], [0.07, 0.78], [0.50, 0.78], [0.58, 0.80],
      [0.67, 0.60], [0.73, 0.33], [0.78, 0.26], [0.94, 0.24], [0.96, 0.33], [1, 0.30],
    ],
  },
  {
    id: 'spool',
    name: 'Thread Spool',
    points: [
      [0, 0.96], [0.07, 0.96], [0.10, 0.30], [0.30, 0.26], [0.70, 0.26],
      [0.90, 0.30], [0.93, 0.96], [1, 0.96],
    ],
  },
  {
    id: 'spinning-top',
    name: 'Spinning Top',
    points: [
      [0, 0.14], [0.12, 0.16], [0.18, 0.50], [0.48, 0.96], [0.62, 0.98],
      [0.80, 0.66], [0.92, 0.16], [1, 0.05],
    ],
  },
  {
    id: 'step-shaft',
    name: 'Stepped Shaft (machine)',
    points: [
      [0, 0.52], [0.20, 0.52], [0.23, 0.80], [0.44, 0.80], [0.47, 0.38],
      [0.68, 0.38], [0.71, 0.64], [0.92, 0.64], [0.95, 0.28], [1, 0.28],
    ],
  },
  {
    id: 'pulley',
    name: 'V-Belt Pulley',
    points: [
      [0, 0.92], [0.13, 0.92], [0.18, 0.55], [0.46, 0.36], [0.5, 0.34],
      [0.54, 0.36], [0.82, 0.55], [0.87, 0.92], [1, 0.92],
    ],
  },
];

// ---------------------------------------------------------------------------
// 2D patterns on the unrolled map. Each returns depth ratio ∈ [0,1];
// u01 = U / circumference ∈ [0,1), t = V / length ∈ [0,1].
// params: { count: grooves around circumference, turns: spirals along length }
// ---------------------------------------------------------------------------
export const PATTERNS = [
  { id: 'none', name: 'None (turning only)' },
  { id: 'spiral', name: 'Spiral Flutes', f: (u01, t, p) => spiralDepth(u01, t, p.count, p.turns) },
  { id: 'reeding', name: 'Straight Reeding', f: (u01, t, p) => spiralDepth(u01, t, p.count, 0) },
  {
    id: 'diamond',
    name: 'Diamond Reeding',
    f: (u01, t, p) => Math.max(
      spiralDepth(u01, t, p.count, p.turns),
      spiralDepth(u01, t, p.count, -p.turns),
    ),
  },
];

/**
 * Narrow flute ridges on the unrolled map.
 * sin(2π·(count·u01 + turns·t)) draws `count` grooves around the circumference
 * that drift along V at `turns` full cycles over the length: with turns ≠ 0
 * these are diagonal lines in 2D — spiral flutes once re-mapped onto the part.
 * pow(·,4) sharpens the sine crest so grooves are narrow rather than wavy.
 */
function spiralDepth(u01, t, count, turns) {
  const s = Math.sin(2 * Math.PI * (count * u01 + turns * t));
  return Math.pow(Math.max(0, s), 4);
}

// ---------------------------------------------------------------------------
// Monotone cubic Hermite interpolation of profile control points.
// points: [[t, r], ...] sorted ascending by t (duplicates tolerated).
// ---------------------------------------------------------------------------
export function makeProfileInterpolator(points) {
  const pts = points.map(([t, r]) => [Number(t), Number(r)]);
  if (!pts.length) throw new Error('profile needs at least one point');
  pts.sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  // Secant slopes.
  const delta = new Array(Math.max(n - 1, 1));
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1][0] - pts[i][0];
    delta[i] = h > 1e-9 ? (pts[i + 1][1] - pts[i][1]) / h : 0;
  }
  // One-sided then Fritsch–Carlson limited tangents (no overshoot).
  const m = new Array(n);
  m[0] = delta[0] ?? 0;
  m[n - 1] = delta[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) m[i] = 0;
    else m[i] = (delta[i - 1] + delta[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(delta[i]) < 1e-12) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * delta[i];
      m[i + 1] = tau * b * delta[i];
    }
  }
  return function interp(t) {
    if (n === 1 || t <= pts[0][0]) return pts[0][1];
    if (t >= pts[n - 1][0]) return pts[n - 1][1];
    let i = 0;
    while (i < n - 2 && t > pts[i + 1][0]) i++;
    const h = pts[i + 1][0] - pts[i][0];
    const u = h > 1e-9 ? (t - pts[i][0]) / h : 0;
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    return h00 * pts[i][1] + h10 * h * m[i] + h01 * pts[i + 1][1] + h11 * h * m[i + 1];
  };
}

// ---------------------------------------------------------------------------
// Design factory.
// ---------------------------------------------------------------------------
/**
 * @param {object} design  { profile, pattern, patternCount, patternTurns,
 *                           patternDepth, custom }
 * @param {{length:number, R0:number}} stock
 * @returns {{targetRadius(u,v), profileRadius(v), minTarget(), meta}}
 */
export function makeDesign(design, stock) {
  const L = stock.length;
  const R0 = stock.R0;
  let interp, meta = {};
  let patId = design.pattern;
  let patCount = design.patternCount;
  let patTurns = design.patternTurns;
  let patDepth = design.patternDepth;

  const custom = design.custom && design.custom.trim();
  if (custom) {
    const parsed = parseCustomProfile(custom, L, R0);
    interp = parsed.interp;
    meta.custom = true;
    // The custom JSON may also override the pattern fields.
    if (parsed.obj.pattern != null) patId = parsed.obj.pattern;
    if (parsed.obj.patternCount != null) patCount = parsed.obj.patternCount;
    if (parsed.obj.patternTurns != null) patTurns = parsed.obj.patternTurns;
    if (parsed.obj.patternDepth != null) patDepth = parsed.obj.patternDepth;
  } else {
    const preset = PROFILES.find((p) => p.id === design.profile) || PROFILES[0];
    interp = makeProfileInterpolator(preset.points);
    meta.profile = preset.id;
  }

  const patDef = PATTERNS.find((p) => p.id === patId) || PATTERNS[0];
  const patParams = { count: Math.max(2, patCount | 0), turns: patTurns };
  const depthScale = Math.max(0, Math.min(0.9, patDepth));
  const circ = 2 * Math.PI * R0;

  /** Axisymmetric profile radius only (mm). v ∈ [0, L]. */
  function profileRadius(v) {
    const r = interp(Math.min(1, Math.max(0, v / L))) * R0;
    return Math.min(Math.max(r, 0.01 * R0), R0);
  }

  /** Full target surface radius (mm) at unrolled map position (U, V). */
  function targetRadius(u, v) {
    let r = profileRadius(v);
    if (patDef.f) {
      const u01 = ((u % circ) + circ) % circ / circ;
      r -= patDef.f(u01, v / L, patParams) * depthScale * R0;
    }
    return Math.min(Math.max(r, 0.02 * R0), R0);
  }

  /** Global minimum target radius — rough levels never step below this. */
  let minTarget = R0;
  const SAMPLES = 256;
  for (let i = 0; i <= SAMPLES; i++) {
    const v = (i / SAMPLES) * L;
    minTarget = Math.min(minTarget, profileRadius(v) - (patDef.f ? depthScale * R0 : 0));
  }
  minTarget = Math.max(minTarget, 0.02 * R0);

  return { targetRadius, profileRadius, minTarget: () => minTarget, meta };
}

/**
 * Parse the custom-design JSON accepted in the UI. Control points are given in
 * absolute millimetres — what a woodworker measures:
 *   { "profile": [[0, 25], [60, 20], [120, 24], [200, 12]],
 *     "pattern": "spiral", "patternCount": 6, "patternTurns": 3, "patternDepth": 0.15 }
 * Throws Error with a human-readable message on malformed input.
 * (makeDesign's custom branch consumes this; callers go through makeDesign.)
 */
function parseCustomProfile(text, L, R0) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`Custom JSON: ${e.message}`);
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.profile) || obj.profile.length < 2) {
    throw new Error('Custom JSON needs a "profile" array of ≥2 [x_mm, radius_mm] pairs');
  }
  const pts = [];
  for (const pair of obj.profile) {
    if (!Array.isArray(pair) || pair.length < 2 || !isFinite(pair[0]) || !isFinite(pair[1])) {
      throw new Error(`Bad profile point: ${JSON.stringify(pair)}`);
    }
    if (pair[1] <= 0) throw new Error(`Profile radius must be > 0: ${JSON.stringify(pair)}`);
    pts.push([pair[0] / L, Math.min(pair[1], R0) / R0]);
  }
  return { interp: makeProfileInterpolator(pts), obj };
}
