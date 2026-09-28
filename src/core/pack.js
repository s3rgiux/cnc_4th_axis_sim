/**
 * pack.js — flat typed-array encoding of a program's segments, so a worker
 * can hand a 100k-block program to the main thread as a couple of buffers
 * (transferable) instead of a structured clone of 100k small objects.
 */
const MODES = ['G0', 'G1'];
const GROUPS = ['rapid', 'rough', 'finish', 'detail', 'park'];

export function packProgram(program) {
  const segs = program.segments;
  const n = segs.length;
  const num = new Float64Array(n * 4);
  const tag = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    num[i * 4] = s.X; num[i * 4 + 1] = s.Z; num[i * 4 + 2] = s.A; num[i * 4 + 3] = s.F;
    tag[i * 2] = s.mode === 'G1' ? 1 : 0;
    const g = GROUPS.indexOf(s.group);
    tag[i * 2 + 1] = g < 0 ? 0 : g;
  }
  return { n, num, tag, stats: program.stats };
}

export function unpackProgram({ n, num, tag, stats }) {
  const segments = new Array(n);
  for (let i = 0; i < n; i++) {
    segments[i] = {
      mode: MODES[tag[i * 2]],
      X: num[i * 4], Z: num[i * 4 + 1], A: num[i * 4 + 2], F: num[i * 4 + 3],
      group: GROUPS[tag[i * 2 + 1]],
    };
  }
  return { segments, stats };
}
