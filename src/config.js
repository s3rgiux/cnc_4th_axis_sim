/**
 * config.js — default machine parameters (millimetres, mm/min feeds).
 * The UI reads these to seed its inputs; core modules receive plain objects.
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
  tool: {
    type: 'ball',             // 'flat' | 'ball'
    diameter: 6,
    stepover: 2,              // lateral step between finishing passes (mm)
    doc: 3,                   // roughing depth of cut per level (radial mm)
    allowance: 0.2,           // finishing allowance left by roughing (mm)
  },
  strategy: {
    rough: 'spiral',          // '' (off) | 'indexed' | 'spiral'
    roughPitch: 4,            // spiral roughing: axial advance per revolution (mm/rev)
    indexes: 12,              // indexed roughing: discrete A positions per level
    finish: 'helical',        // 'helical' | 'raster'
    pitch: 3,                 // helical finishing: axial advance per revolution (mm/rev)
    angularStep: 2,           // helix sampling resolution (deg of A per G-code block)
  },
  feeds: {
    rough: 1200,              // mm/min
    finish: 800,
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
    nx: 110,                  // stock heightmap columns along X (axial)
    nth: 120,                 // stock heightmap columns around circumference
  },
};
