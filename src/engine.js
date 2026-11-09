/* Jelly Block rules, play test, checks and the solver.
   Rules come from the Jelly Block GDD (1.2 Main game mechanics, 1.4 Elements) and the level/v1 files.
   Coordinates are [x, y]: x is the column from the left, y is the row from the top. */

export const COLORS = [
  {key: 'red', name: 'Red', hex: '#FF2D3D', letter: 'r'},
  {key: 'yellow', name: 'Yellow', hex: '#FFC814', letter: 'y'},
  {key: 'blue', name: 'Blue', hex: '#1F6BFF', letter: 'b'},
  {key: 'green', name: 'Green', hex: '#28DC8C', letter: 'g'},
  {key: 'purple', name: 'Purple', hex: '#A23CFF', letter: 'p'},
  {key: 'orange', name: 'Orange', hex: '#FF8A1A', letter: 'o'},
  {key: 'cyan', name: 'Cyan', hex: '#19D8F5', letter: 'c'},
  {key: 'pink', name: 'Pink', hex: '#FF4FB0', letter: 'k'}
];
export const COLOR = Object.fromEntries(COLORS.map(c => [c.key, c]));
export const KINDS = ['round', 'axle'];           // axle = the X-shaped hole and X Stud
export const AXES = ['horizontal', 'vertical'];
/* board characters: '.' open cell, 'W' wall, '#' no cell (outside the board shape) */
export const isOpen = ch => ch === '.';

export const dims = lv => ({w: lv.board.length ? lv.board[0].length : 0, h: lv.board.length});
const k2 = (x, y) => x + ',' + y;

/* ---------- static data and game state ---------- */
/* A game keeps the level's static data plus a small state: each block's offset from its start and whether it is gone. */
export function newGame(lv) {
  const {w, h} = dims(lv);
  const open = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) open[y * w + x] = isOpen(lv.board[y][x]) ? 1 : 0;
  const blocks = lv.blocks.map((b, i) => ({
    i, id: b.id, color: b.color, cells: b.cells.map(c => [c[0], c[1]]),
    socket: b.socket ? [b.socket[0], b.socket[1]] : null, kind: b.socketKind || 'round',
    axis: b.axis || null, cover: b.cover | 0, freeze: b.freeze | 0, lockPin: b.lockPin || null, spoon: b.spoon || null
  }));
  const owner = new Map();
  blocks.forEach(b => b.cells.forEach(([x, y]) => owner.set(k2(x, y), b.i)));
  const joints = [];
  (lv.joints || []).forEach(j => {
    const a = owner.get(k2(j.a[0], j.a[1])), b = owner.get(k2(j.b[0], j.b[1]));
    if (a != null && b != null && a !== b) joints.push([a, b]);
  });
  const targets = lv.targets.map((t, i) => ({i, x: t.at[0], y: t.at[1], color: t.color, kind: t.kind || 'round', freeze: t.freeze | 0}));
  const S = {w, h, open, blocks, targets, joints, n: blocks.length};
  return {S, off: new Int16Array(blocks.length * 2), gone: new Uint8Array(blocks.length), moves: 0};
}
export const snap = g => ({off: g.off.slice(), gone: g.gone.slice(), moves: g.moves});
export const restore = (g, s) => { g.off = s.off.slice(); g.gone = s.gone.slice(); g.moves = s.moves; };
export const stateKey = g => { let s = ''; for (let i = 0; i < g.S.n; i++) s += g.gone[i] ? 'x;' : g.off[2 * i] + ',' + g.off[2 * i + 1] + ';'; return s; };

export const clears = g => { let c = 0; for (let i = 0; i < g.S.n; i++) c += g.gone[i]; return c; };
export const remaining = g => g.S.n - clears(g);
export const won = g => remaining(g) === 0;
export function unlocked(g) { const u = new Set(); g.S.blocks.forEach(b => { if (g.gone[b.i] && b.spoon) u.add(b.spoon); }); return u; }
/* counters count down by one for every block cleared */
export const coverLeft = (g, b) => Math.max(0, b.cover - clears(g));
export const freezeLeft = (g, b) => Math.max(0, b.freeze - clears(g));
export const studFreezeLeft = (g, t) => Math.max(0, t.freeze - clears(g));
export const isLocked = (g, b, u) => !!b.lockPin && !(u || unlocked(g)).has(b.lockPin);
/* a stud clears when every block of its color is cleared */
export function studActive(g, t) {
  return g.S.blocks.some(b => !g.gone[b.i] && b.color === t.color);
}
export function cellsOf(g, b) { const dx = g.off[2 * b.i], dy = g.off[2 * b.i + 1]; return b.cells.map(([x, y]) => [x + dx, y + dy]); }
export function socketOf(g, b) { return b.socket ? [b.socket[0] + g.off[2 * b.i], b.socket[1] + g.off[2 * b.i + 1]] : null; }

/* linked groups: blocks joined by joints, among the blocks still on the board */
export function groups(g) {
  const {n, joints} = g.S, p = [...Array(n).keys()];
  const f = x => { while (p[x] !== x) x = p[x] = p[p[x]]; return x; };
  joints.forEach(([a, b]) => { if (!g.gone[a] && !g.gone[b]) p[f(a)] = f(b); });
  const m = new Map();
  for (let i = 0; i < n; i++) if (!g.gone[i]) { const r = f(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); }
  return [...m.values()];
}
export const groupOf = (g, i) => groups(g).find(gr => gr.includes(i)) || [i];

/* why a group cannot move right now, or '' when it can */
export function stuckReason(g, members, u) {
  u = u || unlocked(g);
  for (const i of members) {
    const b = g.S.blocks[i];
    if (freezeLeft(g, b) > 0) return b.id + ' is frozen';
    if (isLocked(g, b, u)) return b.id + ' is held by a locked hole';
  }
  const ax = new Set(members.map(i => g.S.blocks[i].axis).filter(Boolean));
  if (ax.size > 1) return 'the group has arrow blocks on both axes';
  return '';
}
const DIRS = {free: [[1, 0], [-1, 0], [0, 1], [0, -1]], horizontal: [[1, 0], [-1, 0]], vertical: [[0, 1], [0, -1]]};

/* Every place a group can be dragged to, cell by cell. A placement where a block's hole sits on a matching stud
   clears that block at once, so the drag cannot go past it. Returns [{dx, dy, clear:[block index]}], without the start. */
export function reach(g, members, opts) {
  const {S} = g, {w, h, open} = S, u = unlocked(g);
  if (!(opts && opts.ignoreStuck) && stuckReason(g, members, u)) return [];
  const inG = new Set(members);
  const occ = new Uint8Array(w * h);
  S.blocks.forEach(b => { if (g.gone[b.i] || inG.has(b.i)) return; cellsOf(g, b).forEach(([x, y]) => { if (x >= 0 && y >= 0 && x < w && y < h) occ[y * w + x] = 1; }); });
  const stud = new Map();
  S.targets.forEach(t => { if (studActive(g, t)) stud.set(t.y * w + t.x, t); });
  const parts = members.map(i => {
    const b = S.blocks[i];
    return {b, cells: cellsOf(g, b), sock: socketOf(g, b), hidden: coverLeft(g, b) > 0};
  });
  const axes = new Set(members.map(i => S.blocks[i].axis).filter(Boolean));
  const dirs = DIRS[axes.size ? [...axes][0] : 'free'];
  const test = (dx, dy) => {
    const clear = [];
    for (const p of parts) {
      let hit = false;
      for (const [cx, cy] of p.cells) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) return null;
        const at = y * w + x;
        if (!open[at] || occ[at]) return null;
        const t = stud.get(at);
        if (t) {
          const isSock = p.sock && p.sock[0] === cx && p.sock[1] === cy;
          if (!isSock || p.hidden || t.color !== p.b.color || t.kind !== p.b.kind || studFreezeLeft(g, t) > 0) return null;
          hit = true;
        }
      }
      if (hit) clear.push(p.b.i);
    }
    return clear;
  };
  const seen = new Set(['0,0']), out = [], q = [[0, 0]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [ddx, ddy] of dirs) {
      const nx = x + ddx, ny = y + ddy, key = nx + ',' + ny;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = test(nx, ny);
      if (!c) continue;
      out.push({dx: nx, dy: ny, clear: c});
      if (!c.length) q.push([nx, ny]);
    }
  }
  return out;
}

/* apply a move: shift the group, then clear the blocks whose hole landed on a matching stud */
export function applyMove(g, members, dx, dy, clear) {
  members.forEach(i => { g.off[2 * i] += dx; g.off[2 * i + 1] += dy; });
  (clear || []).forEach(i => { g.gone[i] = 1; });
  g.moves++;
}
/* Hand booster: remove one block. Magnet booster: clear every block of a stud's color. Neither counts as a move. */
export function removeBlocks(g, idx) { idx.forEach(i => { g.gone[i] = 1; }); }

/* every legal move from the current state */
export function allMoves(g) {
  const out = [];
  groups(g).forEach(gr => reach(g, gr).forEach(m => out.push({members: gr, ...m})));
  return out;
}

/* ---------- solver ----------
   A* over board states; one move = one drag of one block or linked group to any place it can reach.
   Lower bound: every linked group still on the board needs at least one more move.
   Shortcut: when a single unlinked block can clear right now, clearing it is never worse
   (it frees space, counts down counters and activates spoons), so the search takes only that move. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v) { const a = this.a; a.push(v); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p].f < v.f || (a[p].f === v.f && a[p].g >= v.g)) break; a[i] = a[p]; i = p; } a[i] = v; }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      let i = 0; const n = a.length;
      for (;;) {
        let l = 2 * i + 1, r = l + 1, m = i, mv = last;
        if (l < n && (a[l].f < mv.f || (a[l].f === mv.f && a[l].g > mv.g))) { m = l; mv = a[l]; }
        if (r < n && (a[r].f < mv.f || (a[r].f === mv.f && a[r].g > mv.g))) { m = r; mv = a[r]; }
        if (m === i) break;
        a[i] = a[m]; i = m;
      }
      a[i] = last;
    }
    return top;
  }
}
function successors(g) {
  const gs = groups(g);
  for (const gr of gs) {
    if (gr.length !== 1) continue;
    const m = reach(g, gr).find(m => m.clear.length);
    if (m) return [{members: gr, ...m}];
  }
  const out = [];
  gs.forEach(gr => reach(g, gr).forEach(m => out.push({members: gr, ...m})));
  return out;
}
const hOf = g => groups(g).length;

/* returns {status:'solved'|'unsolvable'|'limit', moves, path:[move], nodes} */
export function solve(lv, opts) {
  opts = opts || {};
  const limit = opts.limit || 250000, wgt = opts.greedy ? 3 : 1;
  const g = newGame(lv);
  if (opts.from) restore(g, opts.from);
  const start = snap(g), startKey = stateKey(g);
  const meta = new Map([[startKey, {parent: null, move: null, g: 0}]]);
  const heap = new Heap();
  heap.push({f: hOf(g), g: 0, key: startKey, s: start});
  let nodes = 0;
  while (heap.size) {
    const cur = heap.pop(), info = meta.get(cur.key);
    if (cur.g > info.g) continue;
    restore(g, cur.s);
    if (won(g)) {
      const path = []; let k = cur.key;
      while (meta.get(k).parent != null) { const m = meta.get(k); path.push(m.move); k = m.parent; }
      path.reverse();
      return {status: 'solved', moves: cur.g, path, nodes};
    }
    if (++nodes > limit) return {status: 'limit', nodes};
    const succ = successors(g);
    for (const m of succ) {
      restore(g, cur.s);
      applyMove(g, m.members, m.dx, m.dy, m.clear);
      const key = stateKey(g), ng = cur.g + 1, old = meta.get(key);
      if (old && old.g <= ng) continue;
      meta.set(key, {parent: cur.key, move: {members: m.members, dx: m.dx, dy: m.dy, clear: m.clear}, g: ng});
      const h = hOf(g);
      heap.push({f: ng + wgt * h, g: ng, key, s: snap(g)});
    }
  }
  return {status: 'unsolvable', nodes};
}

/* Traps: first moves from the start board after which the level can no longer be solved. */
export function countTraps(lv, opts) {
  opts = opts || {};
  const g = newGame(lv), start = snap(g), moves = allMoves(g);
  let traps = 0, unknown = 0; const list = [];
  for (const m of moves) {
    restore(g, start);
    applyMove(g, m.members, m.dx, m.dy, m.clear);
    const r = solve(lv, {from: snap(g), greedy: true, limit: opts.limit || 20000});
    if (r.status === 'unsolvable') { traps++; list.push(m); }
    else if (r.status === 'limit') unknown++;
  }
  return {traps, unknown, total: moves.length, list};
}

/* readable move: "y1 ↓2 → clears y1" */
export function moveText(lv, m) {
  const ids = m.members.map(i => lv.blocks[i].id);
  const dir = [];
  if (m.dx) dir.push((m.dx > 0 ? '→' : '←') + Math.abs(m.dx));
  if (m.dy) dir.push((m.dy > 0 ? '↓' : '↑') + Math.abs(m.dy));
  return ids.join('+') + ' ' + dir.join(' ') + (m.clear.length ? ' ✓' + m.clear.map(i => lv.blocks[i].id).join(',') : '');
}

/* ---------- checks ---------- */
export function check(lv) {
  const out = [], bad = t => out.push({lvl: 'bad', t}), warn = t => out.push({lvl: 'warn', t});
  const {w, h} = dims(lv);
  if (!h || !w) { bad('The board is empty.'); return out; }
  lv.board.forEach((r, y) => { if (r.length !== w) bad(`Board row ${y} has ${r.length} cells, not ${w}.`); if (/[^.W#]/.test(r)) bad(`Board row ${y} has a character other than . W #.`); });
  if (!(lv.time > 0)) warn('Time is not set.');
  const cell = (x, y) => (y >= 0 && y < h && x >= 0 && x < w) ? lv.board[y][x] : null;
  const ids = new Set(), occ = new Map(), studAt = new Map();
  lv.targets.forEach((t, i) => {
    const nm = `Stud ${i + 1} (${t.color})`;
    if (!COLOR[t.color]) bad(`${nm} has an unknown color.`);
    if (!KINDS.includes(t.kind)) bad(`${nm} has an unknown kind "${t.kind}".`);
    const c = cell(t.at[0], t.at[1]);
    if (c == null) bad(`${nm} is outside the board.`); else if (!isOpen(c)) bad(`${nm} sits on a wall or missing cell.`);
    const k = k2(t.at[0], t.at[1]);
    if (studAt.has(k)) bad(`${nm} shares a cell with another stud.`);
    studAt.set(k, t);
    if (t.freeze > lv.blocks.length) bad(`${nm}: frozen for ${t.freeze} clears, but the level has only ${lv.blocks.length} blocks.`);
  });
  lv.blocks.forEach(b => {
    const nm = `Block ${b.id}`;
    if (ids.has(b.id)) bad(`Two blocks use the id ${b.id}.`);
    ids.add(b.id);
    if (!COLOR[b.color]) bad(`${nm} has an unknown color.`);
    if (!b.cells.length) bad(`${nm} has no cells.`);
    b.cells.forEach(([x, y]) => {
      const c = cell(x, y), k = k2(x, y);
      if (c == null) bad(`${nm} has a cell outside the board at ${x},${y}.`); else if (!isOpen(c)) bad(`${nm} covers a wall at ${x},${y}.`);
      if (occ.has(k)) bad(`${nm} overlaps ${occ.get(k)} at ${x},${y}.`);
      occ.set(k, b.id);
      if (studAt.has(k)) bad(`${nm} starts on top of a stud at ${x},${y}.`);
    });
    const set = new Set(b.cells.map(([x, y]) => k2(x, y)));
    if (b.cells.length) {
      const seen = new Set([k2(...b.cells[0])]), q = [b.cells[0]];
      while (q.length) { const [x, y] = q.pop(); [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => { const k = k2(x + dx, y + dy); if (set.has(k) && !seen.has(k)) { seen.add(k); q.push([x + dx, y + dy]); } }); }
      if (seen.size !== set.size) bad(`${nm}: its cells are not joined into one piece.`);
    }
    if (!b.socket || !set.has(k2(b.socket[0], b.socket[1]))) bad(`${nm}: the hole is not on one of its cells.`);
    if (!KINDS.includes(b.socketKind)) bad(`${nm} has an unknown hole kind "${b.socketKind}".`);
    if (b.axis && !AXES.includes(b.axis)) bad(`${nm} has an unknown axis "${b.axis}".`);
    if (COLOR[b.color] && !lv.targets.some(t => t.color === b.color && t.kind === b.socketKind))
      bad(`${nm} can never clear: no ${b.socketKind === 'axle' ? 'X ' : ''}stud is ${b.color}.`);
    const others = lv.blocks.length - 1;
    if (b.cover > others) bad(`${nm}: hidden for ${b.cover} clears, but only ${others} other blocks can clear.`);
    if (b.freeze > others) bad(`${nm}: frozen for ${b.freeze} clears, but only ${others} other blocks can clear.`);
    if (b.lockPin) {
      if (b.socketKind !== 'round') bad(`${nm}: a locked hole needs a round hole.`);
      if (!lv.blocks.some(o => o !== b && o.spoon === b.lockPin)) bad(`${nm}: no other block holds a ${b.lockPin} spoon, so the lock never opens.`);
    }
    if (b.spoon && !lv.blocks.some(o => o !== b && o.lockPin === b.spoon)) warn(`${nm}: its ${b.spoon} spoon opens no locked hole.`);
  });
  lv.targets.forEach((t, i) => { if (!lv.blocks.some(b => b.color === t.color && b.socketKind === t.kind)) warn(`Stud ${i + 1} (${t.color}${t.kind === 'axle' ? ', X' : ''}) has no block to take it.`); });
  (lv.joints || []).forEach((j, i) => {
    const a = occ.get(k2(j.a[0], j.a[1])), b = occ.get(k2(j.b[0], j.b[1]));
    if (Math.abs(j.a[0] - j.b[0]) + Math.abs(j.a[1] - j.b[1]) !== 1) bad(`Link ${i + 1} does not join two side-by-side cells.`);
    else if (!a || !b) bad(`Link ${i + 1} is not on two blocks.`);
    else if (a === b) bad(`Link ${i + 1} joins block ${a} to itself.`);
  });
  return out;
}
export const statusOf = issues => issues.some(i => i.lvl === 'bad') ? 'bad' : issues.some(i => i.lvl === 'warn') ? 'warn' : 'ok';

/* ---------- helpers for the editor ---------- */
export function nextBlockId(lv, color) {
  const L = (COLOR[color] || {letter: 'x'}).letter;
  let n = 1; const ids = new Set(lv.blocks.map(b => b.id));
  while (ids.has(L + n)) n++;
  return L + n;
}
/* write a level with keys in the same order as the game files */
export function normalize(lv) {
  const block = b => {
    const o = {id: b.id, color: b.color, cells: b.cells.map(c => [c[0], c[1]]), socket: [b.socket[0], b.socket[1]], socketKind: b.socketKind || 'round'};
    if (b.axis) o.axis = b.axis;
    if (b.cover) o.cover = b.cover | 0;
    if (b.freeze) o.freeze = b.freeze | 0;
    if (b.lockPin) o.lockPin = b.lockPin;
    if (b.spoon) o.spoon = b.spoon;
    return o;
  };
  const target = t => { const o = {at: [t.at[0], t.at[1]], color: t.color, kind: t.kind || 'round'}; if (t.freeze) o.freeze = t.freeze | 0; return o; };
  const o = {schema: lv.schema || 'level/v1', id: lv.id, time: lv.time, reward: lv.reward, board: lv.board.slice(), targets: lv.targets.map(target), blocks: lv.blocks.map(block)};
  if (lv.joints && lv.joints.length) o.joints = lv.joints.map(j => ({a: [j.a[0], j.a[1]], b: [j.b[0], j.b[1]]}));
  o.solution = {minMoves: lv.solution ? lv.solution.minMoves : 0, traps: lv.solution ? lv.solution.traps : 0};
  return o;
}
export function blankLevel(id, w, h) {
  return {schema: 'level/v1', id, time: 60, reward: 20, board: Array.from({length: h}, () => '.'.repeat(w)), targets: [], blocks: [], solution: {minMoves: 0, traps: 0}};
}
