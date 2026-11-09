/* Runs the solver off the main thread so the editor stays responsive. */
import {solve, countTraps} from './engine.js';
self.onmessage = e => {
  const {id, job, level, from, limit} = e.data;
  try {
    if (job === 'solve') {
      const r = solve(level, {from, limit});
      self.postMessage({id, ok: true, result: {status: r.status, moves: r.moves, nodes: r.nodes, path: r.path}});
    } else if (job === 'traps') {
      const r = countTraps(level, {limit});
      self.postMessage({id, ok: true, result: {traps: r.traps, unknown: r.unknown, total: r.total, list: r.list}});
    }
  } catch (err) {
    self.postMessage({id, ok: false, error: String(err && err.message || err)});
  }
};
