/**
 * plan-worker.js — off-main-thread planning.
 *
 *   'generate' → rebuild the design from its spec, run generateProgram and
 *                return the program packed as typed arrays (transferable).
 *   'residue'  → simulate a program against a precomputed floor grid and
 *                return the gouge / rest-material analysis.
 *
 * Only DOM-free core modules are imported. Designs cross the boundary as
 * data: preset/custom parameters, or an imported mesh's cylindrical
 * projection {h, nx, nth} — both producers exist in core.
 */
import { makeDesign } from '../core/profiles.js';
import { makeHeightmapDesign } from '../core/mesh.js';
import { generateProgram } from '../core/toolpath.js';
import { packProgram } from '../core/pack.js';
import { analyzeResidue } from '../core/residue.js';

function designFromSpec(spec, stock) {
  if (spec.imported) {
    const { h, nx, nth, name } = spec.imported;
    return makeHeightmapDesign({ h, nx, nth, meta: {} }, stock.length, stock.R0, name);
  }
  return makeDesign(spec.design, stock);
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'generate') {
      const design = designFromSpec(msg.designSpec, msg.stock);
      const program = generateProgram({
        design, stock: msg.stock, tools: msg.tools, allowance: msg.allowance,
        strategy: msg.strategy, feeds: msg.feeds, clearance: msg.clearance, grid: msg.grid,
      });
      const packed = packProgram(program);
      self.postMessage({ type: 'generate', id: msg.id, packed }, [packed.num.buffer, packed.tag.buffer]);
    } else if (msg.type === 'residue') {
      const res = analyzeResidue(msg.program, msg.ctx);
      self.postMessage({ type: 'residue', id: msg.id, res }, [res.diff.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: msg.type, id: msg.id, error: String((err && err.message) || err) });
  }
};
