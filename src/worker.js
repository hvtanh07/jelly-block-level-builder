/* Runs the solver off the main thread so the editor stays responsive. */
import {solveSmart, countTraps} from './engine.js';
self.onmessage = e => {
  const {id, job, level, from, limit} = e.data;
  try {
    if (job === 'solve') {
      const r = solveSmart(level, {from, limit});
      self.postMessage({id, ok: true, result: {status: r.status, approx: !!r.approx, moves: r.moves, nodes: r.nodes, path: r.path}});
    } else if (job === 'traps') {
      const r = countTraps(level, {limit});
      self.postMessage({id, ok: true, result: {traps: r.traps, unknown: r.unknown, total: r.total, list: r.list}});
    }
  } catch (err) {
    self.postMessage({id, ok: false, error: String(err && err.message || err)});
  }
};
