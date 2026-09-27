/**
 * gcode.js — synchronized 4th-axis G-code post-processor.
 *
 * Consumes PathBuilder segments and emits classic fanuc-style blocks with all
 * changed axis words in ONE block (true coordinated motion):
 *
 *     G1 X120.5 Z15.2 A1440.0 F600
 *
 * A is emitted continuous (accumulating degrees, e.g. 1440.0 = 4 turns),
 * which is how synchronized rotary moves must be posted.
 *
 * DOM-free. Download helpers live in the UI layer.
 */

/** One decimal place, no "-0.0". */
export function fmt1(v) {
  const r = Math.round(v * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1);
}

/**
 * @param {object} program  { segments, stats } from generateProgram()
 * @param {object} meta     { stock, tool, strategy, designName } for comments
 * @returns {{lines: Array<{text:string, seg:number}>, text: string}}
 *   `lines.seg` is the index into program.segments for motion blocks, -1 otherwise.
 */
export function emitGcode(program, meta = {}) {
  const lines = [];
  const push = (text, seg = -1) => lines.push({ text, seg });

  // ---- header ------------------------------------------------------------
  const stock = meta.stock || {};
  const tool = meta.tool || {};
  const toolName = (t) => (t.type === 'ball' ? 'BALL-NOSE'
    : t.type === 'vbit' ? `V-BIT ${fmt1(t.angle ?? 90)}DEG`
      : 'FLAT ENDMILL');
  push('%');
  push('(4TH-AXIS ROTARY SIMULATOR - SYNCHRONIZED X/Z/A PROGRAM)');
  if (meta.designName) push(`(DESIGN: ${meta.designName})`);
  push(`(STOCK: DIA ${fmt1((stock.diameter ?? 0))} X ${fmt1(stock.length ?? 0)} MM)`);
  if (Array.isArray(meta.tools) && meta.tools.length) {
    for (const t of meta.tools) {
      const allow = t.allow == null ? '' : ` ALLOW=${fmt1(t.allow)}`;
      push(`(TOOL: T${t.t} ${toolName(t)} D=${fmt1(t.diameter)}${t.phase ? ` ${t.phase}` : ''}${allow})`);
    }
  } else {
    push(`(TOOL: T1 ${toolName(tool)} D=${fmt1(tool.diameter ?? 0)})`);
  }
  if (meta.strategyText) push(`(STRATEGY: ${meta.strategyText})`);
  push('G21 (UNITS: MILLIMETRES)');
  push('G90 (ABSOLUTE POSITIONING)');
  push('G94 (FEED RATE: MM/MIN)');
  push('G1 A0 (ESTABLISH ROTARY ZERO)');
  push('(--- Machining program ---)');

  // ---- motion ------------------------------------------------------------
  let px = 0, pz = 0, pa = 0;
  let pm = null;
  program.segments.forEach((s, i) => {
    // A pure repeat of the previous modal state would emit an empty block.
    let words = '';
    if (s.X !== px) words += ` X${fmt1(s.X)}`;
    if (s.Z !== pz) words += ` Z${fmt1(s.Z)}`;
    if (s.A !== pa) words += ` A${fmt1(s.A)}`;
    if (!words && s.mode === pm) return; // nothing changed — skip
    let f = '';
    if (s.mode === 'G1') f = ` F${Math.round(s.F)}`;
    push(`${s.mode}${words}${f}`.trim(), i);
    px = s.X; pz = s.Z; pa = s.A; pm = s.mode;
  });

  // ---- footer -------------------------------------------------------------
  push('(--- End of program ---)');
  push('M30 (PROGRAM END)');
  push('%');

  return { lines, text: lines.map((l) => l.text).join('\n') + '\n' };
}

/**
 * Map every segment index to the line index that emits it (for terminal
 * highlighting during playback). Segments merged/omitted by the post-processor
 * keep pointing at the most recent emitted line.
 */
export function buildSegToLine(lines, segCount) {
  const map = new Int32Array(segCount).fill(-1);
  lines.forEach((l, li) => {
    if (l.seg >= 0 && l.seg < segCount) map[l.seg] = li;
  });
  // Forward-fill gaps so every segment resolves to a visible line.
  let last = -1;
  for (let i = 0; i < segCount; i++) {
    if (map[i] >= 0) last = map[i];
    else map[i] = last;
  }
  return map;
}
