/**
 * config.js — default machine parameters (millimetres, mm/min feeds).
 * The UI reads these to seed its inputs; core modules receive plain objects.
 *
 * Machining runs in three phases, each with its own (progressively smaller)
 * cutter and its own allowance — the stock left standing above the design
 * surface after that phase finishes:
 *
 *   rough  →  finish  →  detail
 *   Ø10 flat   Ø4 ball    Ø1 ball/v-bit      (defaults)
 *   leave 3mm  leave 0.5  leave 0.1          (defaults)
 *
 * Tool `type`: 'flat' | 'ball' | 'vbit' (`angle` = V included angle, deg;
 * `diameter` = tip flat for a V-bit).
 */
export const DEFAULTS = {
  stock: {
    length: 200,      // X span of the raw cylinder (mm)
    diameter: 50,     // R0 = 25 mm starting stock
  },
  design: {
    profile: 'classic-leg',   // PROFILES id (turning profile along the length)
    pattern: 'none',          // PATTERNS id (2D depth pattern on the unrolled map)
    patternCount: 8,          // grooves around the circumference
    patternTurns: 2,          // spirals: full turns of the pattern along the length
    patternDepth: 0.22,       // groove depth as fraction of stock radius
    custom: '',               // optional JSON overriding profile/pattern
  },
  tools: {
    rough:  { type: 'flat', diameter: 10, angle: 90, doc: 3 },      // end mill
    finish: { type: 'ball', diameter: 4,  angle: 90, stepover: 2 }, // ball nose
    detail: { type: 'ball', diameter: 1,  angle: 60, stepover: 0.5 },
  },
  allowance: {
    rough: 3,       // stock left above the design surface after roughing
    finish: 0.5,    // … after finishing (removed by detailing)
    detail: 0.1,    // … after detailing (final skin; 0 = cut to exact design)
  },
  strategy: {
    rough: 'spiral',          // '' (off) | 'indexed' | 'spiral'
    roughPitch: 4,            // spiral roughing: axial advance per revolution (mm/rev)
    indexes: 12,              // indexed roughing: discrete A positions per level
    finish: 'helical',        // 'helical' | 'raster'
    pitch: 2,                 // helical finishing: axial advance per revolution (mm/rev)
                              //   Ø4 ball → scallop 2−√(4−1) ≈ 0.27 mm before detailing
    angularStep: 2,           // coarse seed for adaptive sampling (deg of A)
    tolerance: 0.015,         // chordal deviation allowed between block and floor (mm);
                              //   worst-case simulated gouge ≈ 3× this
    scallop: true,            // helical: shrink pitch on axial slopes (constant scallop)
    offset: true,             // plan on the tool-offset surface (false = naive tip-on-surface)
    detail: true,             // third phase: same pass shape, smaller tool
    detailPitch: 0.5,         // detailing helix pitch (mm/rev): Ø1 ball → scallop ≈ 0.07 mm
                              //   (1 mm = 2·Rt would leave 0.5 mm ridges)
  },
  feeds: {
    rough: 1200,              // mm/min
    finish: 800,
    detail: 500,
    rapid: 4000,
  },
  clearance: 4,               // Z travel above stock radius for rapids (mm)
  machine: {                  // travel limits for the overtravel check (mm).
    xMin: -5,                 //   A is deliberately unbounded: continuous
    xMax: 450,                //   multi-turn rotary is the machine's feature.
    zMin: 0.05,               //   (bed covers stock up to ~450; tool stops at axis)
    zMax: 120,
  },
  grid: {
    // ADAPTIVE cylindrical heightmap (experimental): cell counts derive from
    // the stock size so the physical cell stays ~constant instead of a fixed
    // 110×120. Doubled resolution vs the original ~1.83 × 1.31 mm cells.
    cellAxial: 0.9,    // mm per column along X (axial)
    cellArc: 0.65,     // mm per sector along the circumference
    nxMin: 32,         // clamp tiny stocks (and keep huge ones renderable)
    nthMin: 48,
    nxMax: 400,
    nthMax: 360,
  },
};

/**
 * Adaptive grid resolution for a stock: keeps the heightmap cell close to
 * `cellAxial × cellArc` mm whatever the stock size, clamped to sane bounds.
 * Default 200 × Ø50 stock → 224 × 242 ≈ 54k cells (was 110 × 120 ≈ 13k).
 */
export function gridFor(length, R0) {
  const g = DEFAULTS.grid;
  const nx = Math.round(length / g.cellAxial) + 1;
  const nth = Math.round((2 * Math.PI * R0) / g.cellArc);
  return {
    nx: Math.min(Math.max(nx, g.nxMin), g.nxMax),
    nth: Math.min(Math.max(nth, g.nthMin), g.nthMax),
  };
}