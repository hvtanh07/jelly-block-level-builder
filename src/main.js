import './style.css';
import SAMPLES from './data/levels.json';
import {COLORS, COLOR, dims, newGame, snap, restore, stateKey, groups, groupOf, reach, applyMove, removeBlocks, stuckReason,
  cellsOf, socketOf, coverLeft, freezeLeft, studFreezeLeft, studActive, unlocked, won, remaining, clears,
  solve, countTraps, check, statusOf, nextBlockId, normalize, blankLevel, moveText, isOpen} from './engine.js';
import {analyze, toLevel} from './vision.js';
import SolverWorker from './worker.js?worker&inline';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const NS = 'http://www.w3.org/2000/svg';
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const STORE = 'jellyBlockLevelBuilder.v2';
const OLD_STORE = 'jellyBlockLevelBuilder.v1';
/* ids of the element samples the first version shipped with; v1 levels with other ids were made by the user */
const OLD_SAMPLE_IDS = ['L0007', 'L0012', 'L0017', 'L0022', 'L0029', 'L0032', 'L0039'];
const CS = 100;          // board units per cell
const PAD = 22;          // board rim
const hexOf = c => (COLOR[c] || {hex: '#888'}).hex;

/* ---------- state ---------- */
let levels = [], cur = 0, tab = 'level', mode = 'edit', tool = 'select';
let paint = {color: 'red', kind: 'round'};
let sel = null;                 // {type:'block'|'stud', i}
let linkFrom = null;            // [x,y] first cell picked with the link tool
let undo = [], redo = [], lastSnap = '';
let game = null, gameHist = [], booster = null, boostUse = {hand: 0, magnet: 0, freeze: 0};
let timer = {left: 0, frozenUntil: 0, running: false, last: 0, lost: false};
let solverState = {busy: false, result: null, traps: null, forKey: ''};
let hintPath = null, autoTimer = null;
let ref = null;                 // screenshot import: {img, url, an, show, opacity}
let hoverCell = null;
const L = () => levels[cur];

/* ---------- storage ---------- */
function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) {}
  if (saved && Array.isArray(saved.levels) && saved.levels.length) { levels = saved.levels; cur = Math.min(saved.cur | 0, levels.length - 1); }
  else {
    levels = clone(SAMPLES); cur = 0;
    /* keep levels made in the first version, after the game levels */
    try {
      const old = JSON.parse(localStorage.getItem(OLD_STORE) || 'null');
      if (old && Array.isArray(old.levels)) old.levels.filter(l => !OLD_SAMPLE_IDS.includes(l.id)).forEach(l => { if (levels.some(x => x.id === l.id)) l.id = l.id + '_old'; levels.push(l); });
    } catch (e) {}
  }
  try { const p = JSON.parse(localStorage.getItem(STORE + '.prefs') || '{}'); if (p.paint) paint = Object.assign(paint, p.paint); if (p.tab) tab = p.tab; } catch (e) {}
}
function persist() {
  try { localStorage.setItem(STORE, JSON.stringify({levels, cur})); $('#saveNote').textContent = 'Changes are saved in this browser. Export to keep a copy.'; }
  catch (e) { $('#saveNote').textContent = 'This browser is not saving changes. Export before you close the page.'; }
}
function savePrefs() { try { localStorage.setItem(STORE + '.prefs', JSON.stringify({paint, tab})); } catch (e) {} }
const isChanged = lv => { const o = SAMPLES.find(s => s.id === lv.id); return !o || JSON.stringify(normalize(o)) !== JSON.stringify(normalize(lv)); };

/* ---------- history ---------- */
function resetHistory() { undo = []; redo = []; lastSnap = JSON.stringify(L()); syncUndo(); }
function commit() {
  const s = JSON.stringify(L());
  if (s === lastSnap) return;
  undo.push(lastSnap); if (undo.length > 300) undo.shift();
  redo = []; lastSnap = s; solverState = {busy: false, result: null, traps: null, forKey: ''};
  persist(); syncUndo(); refreshList(); refreshBadge();
}
function doUndo() { if (!undo.length) return; redo.push(lastSnap); lastSnap = undo.pop(); levels[cur] = JSON.parse(lastSnap); afterHistory(); }
function doRedo() { if (!redo.length) return; undo.push(lastSnap); lastSnap = redo.pop(); levels[cur] = JSON.parse(lastSnap); afterHistory(); }
function afterHistory() { validateSel(); solverState = {busy: false, result: null, traps: null, forKey: ''}; persist(); syncUndo(); renderAll(); }
function syncUndo() { $('#tUndo').disabled = !undo.length; $('#tRedo').disabled = !redo.length; }
function validateSel() {
  if (!sel) return;
  if (sel.type === 'block' && !L().blocks[sel.i]) sel = null;
  else if (sel.type === 'stud' && !L().targets[sel.i]) sel = null;
}

/* ---------- level list ---------- */
const elemTags = lv => {
  const t = [];
  if (lv.blocks.some(b => b.axis)) t.push('arrow');
  if (lv.blocks.some(b => b.cover)) t.push('hidden');
  if (lv.targets.some(s => s.kind === 'axle')) t.push('X stud');
  if (lv.joints && lv.joints.length) t.push('linked');
  if (lv.blocks.some(b => b.lockPin || b.spoon)) t.push('spoon lock');
  if (lv.blocks.some(b => b.freeze)) t.push('frozen');
  if (lv.targets.some(s => s.freeze)) t.push('frozen stud');
  return t;
};
function refreshList() {
  const q = $('#lvSearch').value.trim().toLowerCase();
  $('#lvList').innerHTML = levels.map((lv, i) => {
    if (q && !(String(lv.id).toLowerCase().includes(q) || elemTags(lv).join(' ').includes(q))) return '';
    const st = statusOf(check(lv)), {w, h} = dims(lv), ch = isChanged(lv), el = elemTags(lv);
    return `<li><button type="button" class="lv" data-i="${i}" aria-current="${i === cur}"><span class="n">${i + 1}</span><span><span class="t">${esc(lv.id)}</span><span class="m">${ch ? '<i>● </i>' : ''}${w}×${h} · ${lv.blocks.length} blocks${el.length ? ' · ' + el.join(', ') : ''}</span></span><span class="dot ${st}" title="${st === 'ok' ? 'No problems' : st === 'warn' ? 'Has warnings' : 'Has errors'}"></span></button></li>`;
  }).join('');
  const a = $('#lvList [aria-current="true"]'); if (a) a.scrollIntoView({block: 'nearest'});
}
function selectLevel(i) {
  if (i < 0 || i >= levels.length) return;
  if (mode === 'play') setMode('edit');
  cur = i; sel = null; linkFrom = null; solverState = {busy: false, result: null, traps: null, forKey: ''};
  resetHistory(); persist(); renderAll();
}
function refreshBadge() {
  const iss = check(L()), b = $('#chkBadge'), n = iss.length;
  b.textContent = n; b.className = 'badge ' + (statusOf(iss) === 'bad' ? 'bad' : n ? 'warn' : '');
}

/* ---------- board drawing ---------- */
const board = $('#board');
const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
function setViewBox() {
  const {w, h} = dims(L());
  board.setAttribute('viewBox', `${-PAD - 40} ${-PAD - 40} ${w * CS + 2 * PAD + 80} ${h * CS + 2 * PAD + 80}`);
}
/* a block shape made of cells: rounded cell squares joined by bridges, like the game */
function blockShape(g, cells, fill, cls) {
  const set = new Set(cells.map(([x, y]) => x + ',' + y)), p = 5, r = 22;
  cells.forEach(([x, y]) => {
    const X = x * CS, Y = y * CS;
    el('rect', {x: X + p, y: Y + p, width: CS - 2 * p, height: CS - 2 * p, rx: r, fill, stroke: fill, 'stroke-width': 1, class: cls || ''}, g);
    if (set.has((x + 1) + ',' + y)) el('rect', {x: X + CS - p - 24, y: Y + p, width: 2 * p + 48, height: CS - 2 * p, fill, stroke: fill, 'stroke-width': 1, class: cls || ''}, g);
    if (set.has(x + ',' + (y + 1))) el('rect', {x: X + p, y: Y + CS - p - 24, width: CS - 2 * p, height: 2 * p + 48, fill, stroke: fill, 'stroke-width': 1, class: cls || ''}, g);
    if (set.has((x + 1) + ',' + y) && set.has(x + ',' + (y + 1)) && set.has((x + 1) + ',' + (y + 1))) el('rect', {x: X + CS - p - 24, y: Y + CS - p - 24, width: 2 * p + 48, height: 2 * p + 48, fill, class: cls || ''}, g);
  });
}
function outline(g, cells, cls) {
  const set = new Set(cells.map(([x, y]) => x + ',' + y)), p = 3;
  cells.forEach(([x, y]) => {
    const X = x * CS, Y = y * CS;
    if (!set.has(x + ',' + (y - 1))) el('line', {x1: X + p, y1: Y + p, x2: X + CS - p, y2: Y + p, class: cls}, g);
    if (!set.has(x + ',' + (y + 1))) el('line', {x1: X + p, y1: Y + CS - p, x2: X + CS - p, y2: Y + CS - p, class: cls}, g);
    if (!set.has((x - 1) + ',' + y)) el('line', {x1: X + p, y1: Y + p, x2: X + p, y2: Y + CS - p, class: cls}, g);
    if (!set.has((x + 1) + ',' + y)) el('line', {x1: X + CS - p, y1: Y + p, x2: X + CS - p, y2: Y + CS - p, class: cls}, g);
  });
}
function xShape(g, cx, cy, r, stroke, width) {
  el('path', {d: `M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx + r} ${cy - r}L${cx - r} ${cy + r}`, stroke, 'stroke-width': width, 'stroke-linecap': 'round', fill: 'none'}, g);
}
function holeShape(g, x, y, kind) {
  const cx = x * CS + CS / 2, cy = y * CS + CS / 2;
  if (kind === 'axle') xShape(g, cx, cy, 17, '#15123B', 15);
  else { el('circle', {cx, cy, r: 21, class: 'hole'}, g); el('circle', {cx, cy: cy - 3, r: 18, fill: 'rgba(0,0,0,.25)'}, g); }
}
function arrowShape(g, cx, cy, axis) {
  const L2 = 30, h = 13, w = 11, d = axis === 'vertical' ? [0, 1] : [1, 0], px = -d[1], py = d[0];
  const x1 = cx - d[0] * L2, y1 = cy - d[1] * L2, x2 = cx + d[0] * L2, y2 = cy + d[1] * L2;
  const head = (x, y, s) => `M${x} ${y}L${x - s * d[0] * h + px * w} ${y - s * d[1] * h + py * w}L${x - s * d[0] * h - px * w} ${y - s * d[1] * h - py * w}Z`;
  el('path', {d: `M${x1 + d[0] * h} ${y1 + d[1] * h}L${x2 - d[0] * h} ${y2 - d[1] * h}`, stroke: '#fff', 'stroke-width': 8, 'stroke-linecap': 'round'}, g);
  el('path', {d: head(x2, y2, 1) + head(x1, y1, -1), fill: '#fff'}, g);
}
function spoonShape(g, cx, cy, col) {
  el('rect', {x: cx - 4, y: cy, width: 8, height: 24, rx: 4, fill: hexOf(col), stroke: '#fff', 'stroke-width': 3}, g);
  el('ellipse', {cx, cy: cy - 10, rx: 12, ry: 15, fill: hexOf(col), stroke: '#fff', 'stroke-width': 3.5}, g);
}
function lockShape(g, cx, cy, col) {
  el('circle', {cx, cy, r: 30, fill: 'none', stroke: hexOf(col), 'stroke-width': 8}, g);
  el('path', {d: `M${cx - 8} ${cy - 1}v-6a8 8 0 0 1 16 0v6`, fill: 'none', stroke: '#fff', 'stroke-width': 4.5}, g);
  el('rect', {x: cx - 12, y: cy - 2, width: 24, height: 18, rx: 4, fill: '#fff'}, g);
}
/* the cell where a label sits: a non-hole cell near the middle of the block */
function labelCell(cells, sock) {
  const mx = cells.reduce((a, c) => a + c[0], 0) / cells.length, my = cells.reduce((a, c) => a + c[1], 0) / cells.length;
  const pool = cells.filter(c => !sock || c[0] !== sock[0] || c[1] !== sock[1]);
  return (pool.length ? pool : cells).slice().sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my))[0];
}
/* draws one block. st: {cells, sock, hidden, frozen (number), locked, showColorUnderCover} */
function drawBlock(parent, b, st) {
  const g = el('g', {class: 'blk' + (st.stuck ? ' stuck' : ''), 'data-b': b._i}, parent);
  const hiddenPlay = st.hidden && mode === 'play';
  blockShape(g, st.cells, hiddenPlay ? '#7D8597' : hexOf(b.color));
  if (st.hidden && !hiddenPlay) blockShape(el('g', {opacity: 0.6}, g), st.cells, '#7D8597');
  const [sx, sy] = st.sock || st.cells[0];
  if (st.sock) holeShape(g, sx, sy, b.socketKind);
  const lc = labelCell(st.cells, st.sock), lx = lc[0] * CS + CS / 2, ly = lc[1] * CS + CS / 2;
  if (b.axis) arrowShape(g, lx, ly, b.axis);
  if (b.lockPin && st.locked) lockShape(g, sx * CS + CS / 2, sy * CS + CS / 2, b.lockPin);
  if (b.spoon) {
    const sc = st.cells.length > 1 ? lc : [sx, sy], off = st.cells.length > 1 ? 0 : 26;
    spoonShape(g, sc[0] * CS + CS / 2 + off, sc[1] * CS + CS / 2 + (b.axis ? 22 : 0), b.spoon);
  }
  if (st.frozen > 0) { st.cells.forEach(([x, y]) => el('rect', {x: x * CS + 4, y: y * CS + 4, width: CS - 8, height: CS - 8, rx: 22, class: 'ice'}, g)); }
  const num = [];
  if (st.hidden) num.push(st.hiddenN);
  if (st.frozen > 0) num.push(st.frozen);
  if (num.length) { const t = el('text', {x: lx, y: ly + (b.axis ? -2 : 0), class: 'bn'}, g); t.textContent = (st.hidden && st.frozen > 0) ? `${st.hiddenN}·❄${st.frozen}` : (st.hidden ? '' : '❄') + num[0]; }
  if (mode === 'edit') { const [ix, iy] = st.cells.slice().sort((a, b2) => a[1] - b2[1] || a[0] - b2[0])[0]; const t = el('text', {x: ix * CS + 12, y: iy * CS + 10, class: 'lbl'}, g); t.textContent = b.id; }
  return g;
}
function drawStud(parent, t, i, st) {
  const g = el('g', {class: 'stud', 'data-t': i}, parent), cx = t.at[0] * CS + CS / 2, cy = t.at[1] * CS + CS / 2;
  if (t.kind === 'axle') { xShape(g, cx, cy + 3, 19, 'rgba(0,0,0,.35)', 17); xShape(g, cx, cy, 19, hexOf(t.color), 15); }
  else { el('circle', {cx, cy: cy + 4, r: 27, fill: 'rgba(0,0,0,.35)'}, g); el('circle', {cx, cy, r: 27, fill: hexOf(t.color), stroke: 'rgba(255,255,255,.6)', 'stroke-width': 3}, g); }
  if (st.frozen > 0) { el('circle', {cx, cy, r: 42, class: 'ice'}, g); const tx = el('text', {x: cx, y: cy, class: 'bn sm'}, g); tx.textContent = '❄' + st.frozen; }
  return g;
}

let dragView = null;   // what is being dragged right now, drawn on top
function render() {
  const lv = L(), {w, h} = dims(lv);
  setViewBox();
  board.innerHTML = '';
  const defs = el('defs', {}, board);
  defs.innerHTML = '';
  /* rim and tiles */
  const base = el('g', {}, board);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lv.board[y][x] === '#') continue;
    el('rect', {x: x * CS - PAD, y: y * CS - PAD, width: CS + 2 * PAD, height: CS + 2 * PAD, rx: 26, class: 'rim'}, base);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = lv.board[y][x];
    if (c === '#') continue;
    el('rect', {x: x * CS, y: y * CS, width: CS, height: CS, class: 'tile'}, base);
    el('rect', {x: x * CS + 4, y: y * CS + 4, width: CS - 8, height: CS - 8, rx: 12, class: 'tile2'}, base);
  }
  /* walls: a ring, joined to wall neighbours */
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lv.board[y][x] !== 'W') continue;
    el('rect', {x: x * CS + 10, y: y * CS + 10, width: CS - 20, height: CS - 20, rx: 30, class: 'wall'}, base);
    if (x + 1 < w && lv.board[y][x + 1] === 'W') el('rect', {x: x * CS + 50, y: y * CS + 10, width: CS, height: CS - 20, class: 'wall'}, base);
    if (y + 1 < h && lv.board[y + 1][x] === 'W') el('rect', {x: x * CS + 10, y: y * CS + 50, width: CS - 20, height: CS, class: 'wall'}, base);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lv.board[y][x] !== 'W') continue;
    el('rect', {x: x * CS + 34, y: y * CS + 34, width: CS - 68, height: CS - 68, rx: 8, class: 'wallin'}, base);
    if (x + 1 < w && lv.board[y][x + 1] === 'W') el('rect', {x: x * CS + 50, y: y * CS + 34, width: CS, height: CS - 68, class: 'wallin'}, base);
    if (y + 1 < h && lv.board[y + 1][x] === 'W') el('rect', {x: x * CS + 34, y: y * CS + 50, width: CS - 68, height: CS, class: 'wallin'}, base);
  }
  if (mode === 'edit') {
    for (let x = 0; x < w; x++) el('text', {x: x * CS + CS / 2, y: -PAD - 20, class: 'gridlab'}, base).textContent = x;
    for (let y = 0; y < h; y++) el('text', {x: -PAD - 20, y: y * CS + CS / 2, class: 'gridlab'}, base).textContent = y;
  }
  /* screenshot behind the board */
  if (ref && ref.show && ref.an && !ref.an.error && mode === 'edit' && ref.levelId === lv.id) {
    const an = ref.an, sx = w * CS / an.rect.w, sy = h * CS / an.rect.h;
    el('image', {href: ref.url, x: -an.rect.x * sx, y: -an.rect.y * sy, width: ref.img.width * sx, height: ref.img.height * sy, opacity: ref.opacity, class: 'refimg', preserveAspectRatio: 'none'}, board);
  }
  const studs = el('g', {}, board), blocks = el('g', {}, board), over = el('g', {}, board);
  if (mode === 'play') renderPlay(studs, blocks, over);
  else renderEdit(studs, blocks, over);
  if (hoverCell && mode === 'edit' && tool !== 'select') {
    const [x, y] = hoverCell;
    if (x >= 0 && y >= 0 && x < w && y < h) el('rect', {x: x * CS + 2, y: y * CS + 2, width: CS - 4, height: CS - 4, rx: 14, class: 'hover'}, over);
  }
}
function jointMark(g, a, b) {
  const mx = (a[0] + b[0]) / 2 * CS + CS / 2, my = (a[1] + b[1]) / 2 * CS + CS / 2, horiz = a[1] === b[1];
  el('rect', {x: mx - (horiz ? 12 : 22), y: my - (horiz ? 22 : 12), width: horiz ? 24 : 44, height: horiz ? 44 : 24, rx: 9, class: 'jnt'}, g);
}
function renderEdit(studs, blocks, over) {
  const lv = L();
  lv.targets.forEach((t, i) => drawStud(studs, t, i, {frozen: t.freeze | 0}));
  lv.blocks.forEach((b, i) => {
    b._i = i;
    const moving = dragView && dragView.kind === 'editBlock' && dragView.i === i;
    const cells = moving ? b.cells.map(([x, y]) => [x + dragView.dx, y + dragView.dy]) : b.cells;
    const sock = b.socket ? (moving ? [b.socket[0] + dragView.dx, b.socket[1] + dragView.dy] : b.socket) : null;
    const g = drawBlock(blocks, b, {cells, sock, hidden: b.cover > 0, hiddenN: b.cover, frozen: b.freeze | 0, locked: !!b.lockPin});
    delete b._i;
    if (moving) g.setAttribute('class', 'blk drag ghost' + (dragView.ok ? '' : ' bad'));
  });
  (lv.joints || []).forEach(j => jointMark(over, j.a, j.b));
  if (sel && sel.type === 'block' && lv.blocks[sel.i]) outline(over, lv.blocks[sel.i].cells, 'selline');
  if (sel && sel.type === 'stud' && lv.targets[sel.i]) { const t = lv.targets[sel.i]; el('circle', {cx: t.at[0] * CS + CS / 2, cy: t.at[1] * CS + CS / 2, r: 40, class: 'studsel'}, over); }
  if (linkFrom) el('rect', {x: linkFrom[0] * CS + 6, y: linkFrom[1] * CS + 6, width: CS - 12, height: CS - 12, rx: 18, class: 'pending'}, over);
}
function renderPlay(studs, blocks, over) {
  const lv = L(), g = game, u = unlocked(g);
  g.S.targets.forEach((t, i) => { if (studActive(g, t)) drawStud(studs, lv.targets[i], i, {frozen: studFreezeLeft(g, t)}); });
  const dragSet = dragView && dragView.kind === 'play' ? new Set(dragView.members) : new Set();
  const gs = groups(g);
  g.S.blocks.forEach(b => {
    if (g.gone[b.i]) return;
    let cells = cellsOf(g, b), sock = socketOf(g, b);
    if (dragSet.has(b.i)) { cells = cells.map(([x, y]) => [x + dragView.dx, y + dragView.dy]); sock = sock && [sock[0] + dragView.dx, sock[1] + dragView.dy]; }
    const src = Object.assign({}, lv.blocks[b.i], {_i: b.i});
    const gr = gs.find(x => x.includes(b.i));
    const gEl = drawBlock(blocks, src, {cells, sock, hidden: coverLeft(g, b) > 0, hiddenN: coverLeft(g, b), frozen: freezeLeft(g, b), locked: !!b.lockPin && !u.has(b.lockPin), stuck: !!stuckReason(g, gr, u)});
    if (dragSet.has(b.i)) gEl.setAttribute('class', 'blk drag');
  });
  g.S.joints.forEach(([a, b]) => {
    if (g.gone[a] || g.gone[b]) return;
    /* the joint stays on the same cell pair; it moves with the group */
    (lv.joints || []).forEach(j => {
      const ba = g.S.blocks[a], bb = g.S.blocks[b];
      const ia = ba.cells.findIndex(c => c[0] === j.a[0] && c[1] === j.a[1]), ib = bb.cells.findIndex(c => c[0] === j.b[0] && c[1] === j.b[1]);
      if (ia < 0 || ib < 0) return;
      const off = (bi) => { const d = dragSet.has(bi) ? [dragView.dx, dragView.dy] : [0, 0]; return [g.off[2 * bi] + d[0], g.off[2 * bi + 1] + d[1]]; };
      const oa = off(a), ob = off(b);
      jointMark(over, [j.a[0] + oa[0], j.a[1] + oa[1]], [j.b[0] + ob[0], j.b[1] + ob[1]]);
    });
  });
}

/* ---------- pointer → cell ---------- */
function toBoard(e) {
  const pt = board.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(board.getScreenCTM().inverse());
  return [p.x / CS, p.y / CS];
}
const cellOf = e => { const [x, y] = toBoard(e); return [Math.floor(x), Math.floor(y)]; };
const inBoard = ([x, y]) => { const {w, h} = dims(L()); return x >= 0 && y >= 0 && x < w && y < h; };
const blockAt = (lv, x, y) => lv.blocks.findIndex(b => b.cells.some(c => c[0] === x && c[1] === y));
const studAt = (lv, x, y) => lv.targets.findIndex(t => t.at[0] === x && t.at[1] === y);
const cellCh = (lv, x, y) => lv.board[y][x];
const setCh = (lv, x, y, ch) => { const r = lv.board[y]; lv.board[y] = r.slice(0, x) + ch + r.slice(x + 1); };

/* can block i sit at these cells? (edit mode) */
function editFits(lv, i, cells) {
  const {w, h} = dims(lv);
  return cells.every(([x, y]) => x >= 0 && y >= 0 && x < w && y < h && isOpen(cellCh(lv, x, y)) && studAt(lv, x, y) < 0 && lv.blocks.every((b, j) => j === i || !b.cells.some(c => c[0] === x && c[1] === y)));
}
function cellFree(lv, x, y) { return inBoard([x, y]) && isOpen(cellCh(lv, x, y)) && blockAt(lv, x, y) < 0 && studAt(lv, x, y) < 0; }

/* ---------- edit tools ---------- */
const TOOLS = [
  {id: 'select', label: 'Select', key: 'V', tip: 'Select and drag blocks and studs'},
  {id: 'block', label: 'Block', key: 'B', tip: 'Drag across empty cells to draw a block in the paint color. Starting next to the selected block of the same color adds cells to it'},
  {id: 'hole', label: 'Hole', key: 'O', tip: 'Click a block cell to put its hole there. Click the hole again to switch round / X'},
  {id: 'stud', label: 'Stud', key: 'S', tip: 'Click an empty cell to add a stud in the paint color and shape. Click a stud to remove it'},
  {id: 'wall', label: 'Wall', key: 'W', tip: 'Click to add or remove a wall cell'},
  {id: 'void', label: 'No cell', key: 'N', tip: 'Click to cut a cell out of the board shape, or put it back'},
  {id: 'link', label: 'Link', key: 'L', tip: 'Click a block cell, then a touching cell of another block, to link or unlink them'},
  {id: 'erase', label: 'Erase', key: 'E', tip: 'Click to remove a block cell, a stud, a wall or a link'}
];
function renderTools() {
  $('#tools').innerHTML = TOOLS.map(t => `<button class="tb" type="button" data-tool="${t.id}" aria-pressed="${tool === t.id}" title="${esc(t.tip)} (${t.key})">${t.label} <kbd>${t.key}</kbd></button>`).join('');
  $('#paintColors').innerHTML = COLORS.map(c => `<button type="button" class="sw sm" data-col="${c.key}" style="background:${c.hex}" aria-pressed="${paint.color === c.key}" title="${c.name}"></button>`).join('');
  $$('#paintKind button').forEach(b => b.setAttribute('aria-pressed', b.dataset.kind === paint.kind));
}
function setTool(t) { tool = t; linkFrom = null; renderTools(); render(); }

let drag = null;
board.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const [x, y] = cellOf(e);
  if (mode === 'play') return playDown(e, x, y);
  const lv = L();
  board.setPointerCapture(e.pointerId);
  if (tool === 'select') {
    const bi = blockAt(lv, x, y), si = studAt(lv, x, y);
    if (bi >= 0) { sel = {type: 'block', i: bi}; drag = {kind: 'editBlock', i: bi, start: toBoard(e)}; dragView = {kind: 'editBlock', i: bi, dx: 0, dy: 0, ok: true}; }
    else if (si >= 0) { sel = {type: 'stud', i: si}; drag = {kind: 'editStud', i: si, start: [x, y]}; }
    else sel = null;
    renderAll();
    return;
  }
  if (!inBoard([x, y])) return;
  if (tool === 'block') {
    if (!cellFree(lv, x, y)) {
      const bi = blockAt(lv, x, y);
      if (bi >= 0) { sel = {type: 'block', i: bi}; renderAll(); }
      return;
    }
    let bi = -1;
    if (sel && sel.type === 'block') {
      const b = lv.blocks[sel.i];
      if (b && b.color === paint.color && b.cells.some(c => Math.abs(c[0] - x) + Math.abs(c[1] - y) === 1)) { b.cells.push([x, y]); bi = sel.i; }
    }
    if (bi < 0) {
      const b = {id: nextBlockId(lv, paint.color), color: paint.color, cells: [[x, y]], socket: [x, y], socketKind: paint.kind};
      lv.blocks.push(b); bi = lv.blocks.length - 1;
    }
    sel = {type: 'block', i: bi}; drag = {kind: 'paint', i: bi, last: [x, y]};
    renderAll(); return;
  }
  if (tool === 'hole') {
    const bi = blockAt(lv, x, y);
    if (bi < 0) return;
    const b = lv.blocks[bi];
    if (b.socket && b.socket[0] === x && b.socket[1] === y) b.socketKind = b.socketKind === 'axle' ? 'round' : 'axle';
    else { b.socket = [x, y]; b.socketKind = paint.kind; }
    if (b.socketKind === 'axle' && b.lockPin) { delete b.lockPin; toast('A locked hole needs a round hole, so the lock was removed.'); }
    sel = {type: 'block', i: bi}; commit(); renderAll(); return;
  }
  if (tool === 'stud') {
    const si = studAt(lv, x, y);
    if (si >= 0) { const t = lv.targets[si]; if (t.color === paint.color && t.kind === paint.kind) { lv.targets.splice(si, 1); sel = null; } else { t.color = paint.color; t.kind = paint.kind; sel = {type: 'stud', i: si}; } }
    else if (cellFree(lv, x, y)) { lv.targets.push({at: [x, y], color: paint.color, kind: paint.kind}); sel = {type: 'stud', i: lv.targets.length - 1}; }
    commit(); renderAll(); return;
  }
  if (tool === 'wall' || tool === 'void') {
    const ch = tool === 'wall' ? 'W' : '#', now = cellCh(lv, x, y);
    if (now === ch) setCh(lv, x, y, '.');
    else if (blockAt(lv, x, y) < 0 && studAt(lv, x, y) < 0) setCh(lv, x, y, ch);
    else { toast('Clear the block or stud from this cell first.'); return; }
    drag = {kind: 'cells', ch: cellCh(lv, x, y), last: [x, y]};
    commit(); render(); return;
  }
  if (tool === 'link') {
    const bi = blockAt(lv, x, y);
    if (bi < 0) { linkFrom = null; render(); return; }
    if (linkFrom && Math.abs(linkFrom[0] - x) + Math.abs(linkFrom[1] - y) === 1 && blockAt(lv, ...linkFrom) !== bi) {
      toggleJoint(lv, linkFrom, [x, y]); linkFrom = null; commit(); renderAll(); return;
    }
    linkFrom = [x, y]; render(); return;
  }
  if (tool === 'erase') {
    const jIdx = (lv.joints || []).findIndex(j => (j.a[0] === x && j.a[1] === y) || (j.b[0] === x && j.b[1] === y));
    const bi = blockAt(lv, x, y), si = studAt(lv, x, y);
    if (bi >= 0) eraseCell(lv, bi, x, y);
    else if (si >= 0) lv.targets.splice(si, 1);
    else if (cellCh(lv, x, y) !== '.') setCh(lv, x, y, '.');
    else if (jIdx >= 0) lv.joints.splice(jIdx, 1);
    sel = null; commit(); renderAll();
  }
});
board.addEventListener('pointermove', e => {
  const c = cellOf(e);
  $('#coords').textContent = inBoard(c) ? `x ${c[0]} · y ${c[1]}` : '';
  if (mode === 'play') return playMove(e);
  if (!hoverCell || hoverCell[0] !== c[0] || hoverCell[1] !== c[1]) { hoverCell = c; if (!drag && tool !== 'select') render(); }
  if (!drag) return;
  const lv = L();
  if (drag.kind === 'editBlock') {
    const [px, py] = toBoard(e), dx = Math.round(px - drag.start[0]), dy = Math.round(py - drag.start[1]);
    if (dx !== dragView.dx || dy !== dragView.dy) {
      dragView.dx = dx; dragView.dy = dy;
      dragView.ok = editFits(lv, drag.i, lv.blocks[drag.i].cells.map(([x, y]) => [x + dx, y + dy]));
      render();
    }
  } else if (drag.kind === 'editStud') {
    const [x, y] = c, t = lv.targets[drag.i];
    if ((x !== t.at[0] || y !== t.at[1]) && cellFree(lv, x, y)) { t.at = [x, y]; render(); }
  } else if (drag.kind === 'paint') {
    const [x, y] = c, b = lv.blocks[drag.i];
    if (!b || (x === drag.last[0] && y === drag.last[1])) return;
    if (cellFree(lv, x, y) && b.cells.some(q => Math.abs(q[0] - x) + Math.abs(q[1] - y) === 1)) { b.cells.push([x, y]); render(); }
    drag.last = [x, y];
  } else if (drag.kind === 'cells') {
    const [x, y] = c;
    if (!inBoard(c) || (x === drag.last[0] && y === drag.last[1])) return;
    drag.last = [x, y];
    if (drag.ch === '.' ? cellCh(lv, x, y) !== '.' : (cellCh(lv, x, y) === '.' && blockAt(lv, x, y) < 0 && studAt(lv, x, y) < 0)) { setCh(lv, x, y, drag.ch); render(); }
  }
});
function endDrag(e) {
  if (mode === 'play') return playUp(e);
  if (!drag) return;
  const lv = L();
  if (drag.kind === 'editBlock') {
    const {dx, dy, ok} = dragView, b = lv.blocks[drag.i];
    if ((dx || dy) && ok) {
      remapBlock(lv, drag.i, ([x, y]) => [x + dx, y + dy]);
    } else if ((dx || dy) && !ok) toast('The block does not fit there.');
    dragView = null;
  }
  drag = null;
  commit(); renderAll();
}
board.addEventListener('pointerup', endDrag);
board.addEventListener('pointercancel', endDrag);
board.addEventListener('pointerleave', () => { hoverCell = null; $('#coords').textContent = ''; if (mode === 'edit' && !drag) render(); });

function eraseCell(lv, bi, x, y) {
  const b = lv.blocks[bi];
  b.cells = b.cells.filter(c => c[0] !== x || c[1] !== y);
  if (!b.cells.length) { lv.blocks.splice(bi, 1); }
  else if (b.socket[0] === x && b.socket[1] === y) b.socket = b.cells[0].slice();
  pruneJoints(lv);
}
function pruneJoints(lv) {
  if (!lv.joints) return;
  lv.joints = lv.joints.filter(j => { const a = blockAt(lv, ...j.a), b = blockAt(lv, ...j.b); return a >= 0 && b >= 0 && a !== b && Math.abs(j.a[0] - j.b[0]) + Math.abs(j.a[1] - j.b[1]) === 1; });
  if (!lv.joints.length) delete lv.joints;
}
function toggleJoint(lv, a, b) {
  lv.joints = lv.joints || [];
  const i = lv.joints.findIndex(j => (j.a[0] === a[0] && j.a[1] === a[1] && j.b[0] === b[0] && j.b[1] === b[1]) || (j.a[0] === b[0] && j.a[1] === b[1] && j.b[0] === a[0] && j.b[1] === a[1]));
  if (i >= 0) lv.joints.splice(i, 1); else lv.joints.push({a: a.slice(), b: b.slice()});
  if (!lv.joints.length) delete lv.joints;
}
/* move every joint cell of block i along with it (used by nudge, rotate, flip) */
function remapBlock(lv, i, fn) {
  const b = lv.blocks[i], before = b.cells.map(c => c.slice()), map = new Map(before.map(c => [c[0] + ',' + c[1], fn(c)]));
  const after = before.map(fn);
  if (!editFits(lv, i, after)) { toast('The block does not fit there.'); return false; }
  b.cells = after; b.socket = fn(b.socket);
  (lv.joints || []).forEach(j => ['a', 'b'].forEach(k => { const m = map.get(j[k][0] + ',' + j[k][1]); if (m) j[k] = m; }));
  pruneJoints(lv);
  return true;
}
function rotateSel(dir) {
  if (!sel || sel.type !== 'block') return;
  const lv = L(), b = lv.blocks[sel.i], [px, py] = b.socket;
  if (remapBlock(lv, sel.i, ([x, y]) => dir > 0 ? [px - (y - py), py + (x - px)] : [px + (y - py), py - (x - px)])) {
    if (b.axis) b.axis = b.axis === 'vertical' ? 'horizontal' : 'vertical';
    commit(); renderAll();
  }
}
function flipSel() {
  if (!sel || sel.type !== 'block') return;
  const lv = L(), b = lv.blocks[sel.i], px = b.socket[0];
  if (remapBlock(lv, sel.i, ([x, y]) => [2 * px - x, y])) { commit(); renderAll(); }
}
function nudgeSel(dx, dy) {
  if (!sel) return;
  const lv = L();
  if (sel.type === 'block') { if (remapBlock(lv, sel.i, ([x, y]) => [x + dx, y + dy])) { commit(); renderAll(); } }
  else { const t = lv.targets[sel.i], x = t.at[0] + dx, y = t.at[1] + dy; if (cellFree(lv, x, y)) { t.at = [x, y]; commit(); renderAll(); } }
}
function deleteSel() {
  if (!sel) return;
  const lv = L();
  if (sel.type === 'block') { lv.blocks.splice(sel.i, 1); pruneJoints(lv); } else lv.targets.splice(sel.i, 1);
  sel = null; commit(); renderAll();
}
function duplicateSel() {
  if (!sel || sel.type !== 'block') return;
  const lv = L(), b = lv.blocks[sel.i];
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [0, 2], [3, 0], [0, 3]]) {
    const cells = b.cells.map(([x, y]) => [x + dx, y + dy]);
    if (editFits(lv, -1, cells)) {
      const nb = clone(b); nb.cells = cells; nb.socket = [b.socket[0] + dx, b.socket[1] + dy]; nb.id = nextBlockId(lv, b.color);
      lv.blocks.push(nb); sel = {type: 'block', i: lv.blocks.length - 1}; commit(); renderAll(); return;
    }
  }
  toast('No free space next to this block.');
}

/* ---------- play test ---------- */
function setMode(m) {
  if (m === mode) return;
  stopAuto();
  mode = m;
  $('#modeEdit').setAttribute('aria-pressed', m === 'edit');
  $('#modePlay').setAttribute('aria-pressed', m === 'play');
  $$('[data-edit]').forEach(e => e.hidden = m !== 'edit');
  $$('[data-play]').forEach(e => e.hidden = m !== 'play');
  if (m === 'play') startGame(); else { game = null; banner(''); }
  drag = null; dragView = null;
  renderAll();
}
function startGame() {
  game = newGame(L()); gameHist = []; booster = null; boostUse = {hand: 0, magnet: 0, freeze: 0}; hintPath = null;
  timer = {left: L().time || 0, frozenUntil: 0, running: false, last: 0, lost: false};
  syncBoosters(); hud(); banner('Drag a block. The timer starts with your first move.', 'info');
}
function hud() {
  if (!game) return;
  const t = Math.max(0, Math.ceil(timer.left)), c = $('#hudTime');
  c.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  c.className = 'clock' + (performance.now() < timer.frozenUntil ? ' frozen' : t <= 10 && L().time ? ' low' : '');
  $('#hudMoves').textContent = `${game.moves} move${game.moves === 1 ? '' : 's'}${L().solution && L().solution.minMoves ? ` · best ${L().solution.minMoves}` : ''}`;
  $('#hudLeft').textContent = `${remaining(game)} block${remaining(game) === 1 ? '' : 's'} left`;
}
function tick(now) {
  if (mode === 'play' && game && timer.running && !timer.lost && !won(game)) {
    const dt = (now - timer.last) / 1000; timer.last = now;
    if (now >= timer.frozenUntil && L().time) {
      timer.left -= dt;
      if (timer.left <= 0) { timer.left = 0; timer.lost = true; banner('Time is up. Take back, restart, or keep playing to finish the test.', 'lost'); }
    }
    hud();
  } else timer.last = now;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
function pushHist() { gameHist.push(snap(game)); }
function afterPlayMove() {
  if (!timer.running) { timer.running = true; timer.last = performance.now(); }
  hud();
  if (won(game)) {
    const best = L().solution && L().solution.minMoves;
    banner(`Level cleared in ${game.moves} moves${best ? ` (best is ${best})` : ''}.`, 'won');
  } else if (!timer.lost) banner('');
  render();
}
let playDrag = null;
function playDown(e, x, y) {
  if (won(game)) return;
  const g = game;
  if (booster === 'magnet') {
    const t = g.S.targets.find(t => t.x === x && t.y === y && studActive(g, t));
    if (!t) { toast('Tap a stud.'); return; }
    pushHist(); removeBlocks(g, g.S.blocks.filter(b => !g.gone[b.i] && b.color === t.color).map(b => b.i));
    boostUse.magnet++; booster = null; syncBoosters(); afterPlayMove(); return;
  }
  const b = g.S.blocks.find(b => !g.gone[b.i] && cellsOf(g, b).some(c => c[0] === x && c[1] === y));
  if (!b) return;
  if (booster === 'hand') {
    pushHist(); removeBlocks(g, [b.i]); boostUse.hand++; booster = null; syncBoosters(); afterPlayMove(); return;
  }
  const members = groupOf(g, b.i), why = stuckReason(g, members);
  if (why) {
    const gEl = board.querySelector(`.blk[data-b="${b.i}"]`); if (gEl) { gEl.classList.remove('shake'); void gEl.getBBox(); gEl.classList.add('shake'); }
    banner(why.charAt(0).toUpperCase() + why.slice(1) + '.', 'info'); return;
  }
  const opts = reach(g, members), map = new Map(opts.map(o => [o.dx + ',' + o.dy, o]));
  board.setPointerCapture(e.pointerId);
  playDrag = {members, start: toBoard(e), opts, map, cur: {dx: 0, dy: 0, clear: []}};
  dragView = {kind: 'play', members, dx: 0, dy: 0};
  render();
}
function playMove(e) {
  if (!playDrag) return;
  const [px, py] = toBoard(e), wx = px - playDrag.start[0], wy = py - playDrag.start[1];
  /* the reachable place closest to the pointer */
  let best = {dx: 0, dy: 0, clear: []}, bd = Math.hypot(wx, wy);
  playDrag.opts.forEach(o => { const d = Math.hypot(o.dx - wx, o.dy - wy); if (d < bd - 1e-6) { bd = d; best = o; } });
  if (best.dx !== dragView.dx || best.dy !== dragView.dy) { dragView.dx = best.dx; dragView.dy = best.dy; playDrag.cur = best; render(); }
}
function playUp() {
  if (!playDrag) return;
  const m = playDrag.cur, members = playDrag.members; playDrag = null; dragView = null;
  if (m.dx || m.dy) { pushHist(); applyMove(game, members, m.dx, m.dy, m.clear); }
  afterPlayMove();
}
function syncBoosters() {
  $('#bHand').setAttribute('aria-pressed', booster === 'hand'); $('#bMagnet').setAttribute('aria-pressed', booster === 'magnet');
  $('#bHandN').textContent = boostUse.hand; $('#bMagnetN').textContent = boostUse.magnet; $('#bFreezeN').textContent = boostUse.freeze;
}
function playUndo() { if (!gameHist.length) return; restore(game, gameHist.pop()); timer.lost = false; banner(''); afterPlayMove(); }

/* ---------- solver (in a worker) ---------- */
let worker = null, jobId = 0; const jobs = new Map();
/* run a job on this thread, used when the browser cannot start the worker */
function runHere(job, level, extra) {
  return job === 'traps' ? countTraps(level, extra) : solve(level, extra);
}
function runJob(job, level, extra) {
  const data = Object.assign({job, level: normalize(level)}, extra || {});
  return new Promise((resolve, reject) => {
    try {
      if (!worker) {
        worker = new SolverWorker();
        worker.onmessage = e => { const j = jobs.get(e.data.id); if (!j) return; jobs.delete(e.data.id); e.data.ok ? j.resolve(e.data.result) : j.reject(new Error(e.data.error)); };
        worker.onerror = ev => {
          ev.preventDefault && ev.preventDefault();
          const pending = [...jobs.values()]; jobs.clear(); worker = null;
          pending.forEach(j => setTimeout(() => { try { j.resolve(runHere(j.data.job, j.data.level, j.data)); } catch (err) { j.reject(err); } }, 30));
        };
      }
      const id = ++jobId; jobs.set(id, {resolve, reject, data});
      worker.postMessage(Object.assign({id}, data));
    } catch (err) {
      setTimeout(() => { try { resolve(runHere(job, data.level, data)); } catch (e2) { reject(e2); } }, 30);
    }
  });
}
function cancelSolver() { if (worker) { worker.terminate(); worker = null; } jobs.forEach(j => j.reject(new Error('Stopped'))); jobs.clear(); solverState.busy = false; renderPane(); }
async function runSolver() {
  const lv = L(), key = JSON.stringify(lv);
  solverState = {busy: 'solve', result: null, traps: null, forKey: key, t0: performance.now()}; renderPane();
  try {
    const r = await runJob('solve', lv, {limit: +($('#solLimit') ? $('#solLimit').value : 250000)});
    if (JSON.stringify(L()) !== key) return;
    solverState.result = r; solverState.ms = performance.now() - solverState.t0;
    if (r.status === 'solved') {
      solverState.busy = 'traps'; renderPane();
      const t = await runJob('traps', lv, {limit: 20000});
      if (JSON.stringify(L()) !== key) return;
      solverState.traps = t;
    }
  } catch (e) { if (e.message !== 'Stopped') solverState.error = e.message || 'the solver could not run'; }
  solverState.busy = false; renderPane(); refreshBadge();
}
function saveSolution() {
  const r = solverState.result; if (!r || r.status !== 'solved') return;
  L().solution = {minMoves: r.moves, traps: solverState.traps ? solverState.traps.traps : (L().solution ? L().solution.traps : 0)};
  commit(); renderPane(); toast('Saved minMoves ' + r.moves + ' to the level.');
}
async function hintMove(auto) {
  if (!game || won(game)) return;
  const key = stateKey(game);
  if (!hintPath || hintPath.key !== key || !hintPath.path.length) {
    banner('Solving from this board…', 'info');
    try {
      const r = await runJob('solve', L(), {from: snap(game), limit: 250000});
      if (r.status !== 'solved') { banner(r.status === 'limit' ? 'The solver gave up: the search got too big.' : 'No solution from this board. Take back or restart.', 'lost'); stopAuto(); return; }
      hintPath = {key, path: r.path};
    } catch (e) { banner('Solver error: ' + e.message, 'lost'); stopAuto(); return; }
  }
  const m = hintPath.path.shift();
  pushHist(); applyMove(game, m.members, m.dx, m.dy, m.clear);
  hintPath.key = stateKey(game);
  banner(moveText(L(), m), 'info');
  afterPlayMove();
  if (auto && !won(game)) autoTimer = setTimeout(() => hintMove(true), 550); else if (auto) stopAuto();
}
function stopAuto() { if (autoTimer) clearTimeout(autoTimer); autoTimer = null; $('#pAuto') && $('#pAuto').setAttribute('aria-pressed', 'false'); }

/* ---------- inspector ---------- */
function renderPane() {
  $$('#tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  const p = $('#pane');
  if (tab === 'level') p.innerHTML = paneLevel();
  else if (tab === 'sel') p.innerHTML = paneSel();
  else if (tab === 'check') p.innerHTML = paneCheck();
  else if (tab === 'image') { p.innerHTML = paneImage(); drawPreview(); }
  else p.innerHTML = paneJson();
}
const swatchRow = (name, val, none) => `<div class="swatches">${none ? `<button type="button" class="sw none" data-${name}="" aria-pressed="${!val}" title="None">–</button>` : ''}${COLORS.map(c => `<button type="button" class="sw" data-${name}="${c.key}" style="background:${c.hex}" aria-pressed="${val === c.key}" title="${c.name}"></button>`).join('')}</div>`;
function paneLevel() {
  const lv = L(), {w, h} = dims(lv), sol = lv.solution || {minMoves: 0, traps: 0};
  return `<h2>Level</h2>
  <div class="fields">
    <label class="fld"><span>Id <code>id</code></span><input data-lv="id" value="${esc(lv.id)}"></label>
    <label class="fld"><span>Time, seconds <code>time</code></span><input type="number" min="0" step="5" data-lv="time" value="${lv.time}"></label>
    <label class="fld"><span>Reward <code>reward</code></span><input type="number" min="0" data-lv="reward" value="${lv.reward}"></label>
    <span></span>
    <label class="fld"><span>Columns</span><input type="number" min="2" max="16" data-size="w" value="${w}"></label>
    <label class="fld"><span>Rows</span><input type="number" min="2" max="18" data-size="h" value="${h}"></label>
    <label class="fld"><span>Min moves <code>solution.minMoves</code></span><input type="number" min="0" data-sol="minMoves" value="${sol.minMoves}"></label>
    <label class="fld"><span>Traps <code>solution.traps</code></span><input type="number" min="0" data-sol="traps" value="${sol.traps}"></label>
  </div>
  <p class="hint">Columns and rows add or remove cells on the right and bottom. Use the shift buttons to move everything.</p>
  <div class="btns"><button class="btn" data-shift="-1,0">Shift ←</button><button class="btn" data-shift="1,0">Shift →</button><button class="btn" data-shift="0,-1">Shift ↑</button><button class="btn" data-shift="0,1">Shift ↓</button></div>
  <h3>Contents</h3>
  <div class="stat"><b>Blocks</b><span>${lv.blocks.length}</span><b>Studs</b><span>${lv.targets.length}</span><b>Walls</b><span>${lv.board.join('').split('W').length - 1}</span><b>Links</b><span>${(lv.joints || []).length}</span><b>Elements</b><span>${elemTags(lv).join(', ') || 'none'}</span></div>
  <h3>Shortcuts</h3>
  <div class="keys">
    <kbd>V B O S W N L E</kbd><span>Tools: select, block, hole, stud, wall, no cell, link, erase</span>
    <kbd>1–8</kbd><span>Paint color, or recolor the selection</span>
    <kbd>X</kbd><span>Switch round / X for new holes and studs</span>
    <kbd>Arrows</kbd><span>Nudge the selection</span>
    <span><kbd>R</kbd> <kbd>Shift+R</kbd></span><span>Rotate the block around its hole</span>
    <kbd>F</kbd><span>Flip the block left–right</span>
    <kbd>Ctrl+D</kbd><span>Duplicate the block</span>
    <kbd>Del</kbd><span>Delete the selection</span>
    <span><kbd>Ctrl+Z</kbd> <kbd>Ctrl+Y</kbd></span><span>Undo, redo</span>
    <kbd>P</kbd><span>Switch between build and play test</span>
  </div>`;
}
const AXLABEL = {'': 'Free', horizontal: 'Horiz ↔', vertical: 'Vert ↕'};
function paneSel() {
  const lv = L();
  if (!sel) return `<h2>Nothing selected</h2><p class="hint">Pick the Select tool and click a block or a stud.</p>`;
  if (sel.type === 'stud') {
    const t = lv.targets[sel.i];
    return `<h2>Stud ${sel.i + 1} <small class="hint">at ${t.at[0]}, ${t.at[1]}</small></h2>
    <h3>Color</h3>${swatchRow('scolor', t.color)}
    <h3>Shape</h3><div class="seg small"><button type="button" data-skind="round" aria-pressed="${t.kind === 'round'}">● Round</button><button type="button" data-skind="axle" aria-pressed="${t.kind === 'axle'}">✕ X Stud</button></div>
    <div class="elem"><b>Frozen Stud</b><p class="hint">Blocks that must clear before this stud melts. 0 = not frozen.</p><label class="counter fld"><input type="number" min="0" max="40" data-sfreeze value="${t.freeze | 0}"></label></div>
    <div class="btns"><button class="btn" data-act="del">Delete stud</button></div>`;
  }
  const b = lv.blocks[sel.i];
  const others = lv.blocks.length - 1;
  return `<h2>Block <input class="idin" data-bid value="${esc(b.id)}" aria-label="Block id" style="width:70px;border:1px solid var(--line);border-radius:6px;padding:2px 5px;background:var(--paper)"> <small class="hint">${b.cells.length} cell${b.cells.length > 1 ? 's' : ''}, hole at ${b.socket[0]}, ${b.socket[1]}</small></h2>
  <h3>Color</h3>${swatchRow('bcolor', b.color)}
  <h3>Hole <code class="hint">socketKind</code></h3><div class="seg small"><button type="button" data-bkind="round" aria-pressed="${b.socketKind === 'round'}">● Round</button><button type="button" data-bkind="axle" aria-pressed="${b.socketKind === 'axle'}">✕ X hole</button></div>
  <p class="hint">Use the Hole tool to move the hole to another cell.</p>
  <div class="elem"><b>Arrow Block <code class="hint">axis</code></b><p class="hint">Moves along one axis only.</p><div class="seg small">${['', 'horizontal', 'vertical'].map(a => `<button type="button" data-axis="${a}" aria-pressed="${(b.axis || '') === a}">${AXLABEL[a]}</button>`).join('')}</div></div>
  <div class="elem"><b>Hidden Block <code class="hint">cover</code></b><p class="hint">Grey cover. Blocks that must clear before its color shows (max ${others}). 0 = not hidden.</p><label class="counter fld"><input type="number" min="0" max="${Math.max(others, 0)}" data-bnum="cover" value="${b.cover | 0}"></label></div>
  <div class="elem"><b>Frozen Block <code class="hint">freeze</code></b><p class="hint">Cannot move until this many blocks clear (max ${others}). 0 = not frozen.</p><label class="counter fld"><input type="number" min="0" max="${Math.max(others, 0)}" data-bnum="freeze" value="${b.freeze | 0}"></label></div>
  <div class="elem"><b>Lock pin <code class="hint">lockPin</code></b><p class="hint">Locks this block in place until a spoon of this color clears. Round holes only.</p>${b.socketKind === 'round' ? swatchRow('lock', b.lockPin, true) : '<p class="hint"><i>Switch the hole to round to add a lock.</i></p>'}</div>
  <div class="elem"><b>Spoon <code class="hint">spoon</code></b><p class="hint">When this block clears, it opens every lock pin of this color.</p>${swatchRow('spoon', b.spoon, true)}</div>
  <div class="elem"><b>Linked Block <code class="hint">joints</code></b><p class="hint">Use the Link tool: click a cell of this block, then a touching cell of another block.</p>${(lv.joints || []).filter(j => b.cells.some(c => (c[0] === j.a[0] && c[1] === j.a[1]) || (c[0] === j.b[0] && c[1] === j.b[1]))).map(j => `<span class="hint">${j.a.join(',')} ↔ ${j.b.join(',')}</span>`).join(' · ') || '<span class="hint">No links.</span>'}</div>
  <div class="btns"><button class="btn" data-act="rotL">⟲ Rotate</button><button class="btn" data-act="rotR">⟳ Rotate</button><button class="btn" data-act="flip">⇋ Flip</button><button class="btn" data-act="dup">Duplicate</button><button class="btn" data-act="del">Delete</button></div>`;
}
function paneCheck() {
  const lv = L(), iss = check(lv), sv = solverState, r = sv.result, sol = lv.solution || {};
  let s = `<h2>Checks</h2>`;
  s += iss.length ? `<ul class="issues">${iss.map(i => `<li class="${i.lvl}">${esc(i.t)}</li>`).join('')}</ul>` : `<ul class="issues"><li class="ok">No problems found in the level data.</li></ul>`;
  s += `<h3>Solver</h3><p class="hint">Finds the fewest moves to clear the level. One move is one drag of a block (or a linked group) to any place it can reach. Traps are first moves after which the level can no longer be solved.</p>
  <div class="btns"><button class="btn primary" data-act="solve" ${sv.busy ? 'disabled' : ''}>${sv.busy ? (sv.busy === 'traps' ? 'Counting traps…' : 'Solving…') : 'Check solvable'}</button>${sv.busy ? '<button class="btn" data-act="stop">Stop</button>' : ''}
  <label class="fld" style="flex-direction:row;align-items:center;gap:6px"><span>Search limit</span><select id="solLimit"><option value="100000">100k</option><option value="250000" selected>250k</option><option value="1000000">1M</option><option value="3000000">3M</option></select></label></div>`;
  if (sv.error) s += `<ul class="issues"><li class="bad">Solver error: ${esc(sv.error)}</li></ul>`;
  if (r) {
    if (r.status === 'solved') {
      const match = sol.minMoves === r.moves;
      s += `<ul class="issues"><li class="ok"><b>Solvable</b> in <b>${r.moves}</b> moves. ${r.nodes} boards searched${sv.ms ? `, ${(sv.ms / 1000).toFixed(1)} s` : ''}.</li>
      ${sv.traps ? `<li class="${sv.traps.traps ? 'warn' : 'ok'}"><b>${sv.traps.traps}</b> trap move${sv.traps.traps === 1 ? '' : 's'} out of ${sv.traps.total} first moves${sv.traps.unknown ? ` (${sv.traps.unknown} too big to check)` : ''}.</li>` : ''}
      <li class="${match ? 'ok' : 'warn'}">Saved in the level: minMoves ${sol.minMoves ?? '–'}, traps ${sol.traps ?? '–'}.${match ? '' : ' Does not match.'}</li></ul>
      <div class="btns"><button class="btn primary" data-act="saveSol" ${sv.busy ? 'disabled' : ''}>Save to solution</button><button class="btn" data-act="playSol">Watch it in play test</button></div>
      <h3>Moves</h3><ol class="steps">${r.path.map(m => `<li>${esc(moveText(lv, m))}</li>`).join('')}</ol>`;
      if (sv.traps && sv.traps.list.length) s += `<h3>Trap moves</h3><ol class="steps">${sv.traps.list.map(m => `<li>${esc(moveText(lv, m))}</li>`).join('')}</ol>`;
    } else if (r.status === 'unsolvable') s += `<ul class="issues"><li class="bad"><b>Not solvable.</b> Every reachable board was tried (${r.nodes}).</li></ul>`;
    else s += `<ul class="issues"><li class="warn"><b>Not sure.</b> The search stopped at ${r.nodes} boards. Raise the search limit and try again.</li></ul>`;
  }
  return s;
}
function paneJson() {
  return `<h2>Level JSON <small class="hint">schema level/v1</small></h2>
  <textarea class="code" id="jsonText" spellcheck="false">${esc(JSON.stringify(normalize(L()), null, 2))}</textarea>
  <div class="btns"><button class="btn primary" data-act="applyJson">Apply changes</button><button class="btn" data-act="copyJson">Copy</button><button class="btn" data-act="download">Download</button></div>
  <div class="msg" id="jsonMsg"></div>`;
}
function paneImage() {
  const an = ref && ref.an;
  let s = `<h2>Import from a screenshot</h2>
  <p class="hint">Drop or paste a game screenshot. The tool finds the board, reads each cell and builds the level. Check the result after: it cannot read hidden colors, cover numbers or ice yet.</p>
  <label class="dropzone" id="drop">Drop a screenshot here, paste it (Ctrl+V), or <u>choose a file</u><input type="file" accept="image/*" id="imgFile" hidden></label>`;
  if (ref) {
    s += `<h3>Board found</h3><div class="preview"><canvas id="prev"></canvas></div>`;
    if (an && an.error) s += `<ul class="issues"><li class="bad">${esc(an.error)}</li></ul>`;
    if (an && !an.error) {
      s += `<div class="fields" style="margin-top:8px">
      <label class="fld"><span>Columns</span><input type="number" min="2" max="16" id="imCols" value="${an.cols}"></label>
      <label class="fld"><span>Rows</span><input type="number" min="2" max="18" id="imRows" value="${an.rows}"></label>
      <label class="fld"><span>Board left, px</span><input type="number" id="imX" value="${Math.round(an.rect.x)}"></label>
      <label class="fld"><span>Board top, px</span><input type="number" id="imY" value="${Math.round(an.rect.y)}"></label>
      <label class="fld"><span>Board width, px</span><input type="number" id="imW" value="${Math.round(an.rect.w)}"></label>
      <label class="fld"><span>Board height, px</span><input type="number" id="imH" value="${Math.round(an.rect.h)}"></label></div>
      <div class="btns"><button class="btn" data-act="reread">Read again with these numbers</button></div>
      <p class="hint">Found ${an.pieces.length} blocks, ${an.cells.filter(c => c.type === 'stud').length} studs and ${an.cells.filter(c => c.type === 'wall').length} wall cells.</p>
      <div class="btns"><button class="btn primary" data-act="imNew">Add as a new level</button><button class="btn" data-act="imReplace">Replace this level</button></div>
      ${ref.notes && ref.notes.length ? `<h3>Check these</h3><ul class="notes">${ref.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <h3>Screenshot behind the board</h3>
      ${ref.levelId ? `<label class="chk"><input type="checkbox" id="imShow" ${ref.show ? 'checked' : ''}> Show it behind level ${esc(ref.levelId)} in Build mode</label><p class="hint">Off by default. It only shows on the level you imported into, and it is never saved into the level data.</p>` : '<p class="hint">Import the level first, then you can show the screenshot behind it to compare.</p>'}
      <label class="fld" style="margin-top:6px"><span>Opacity</span><input type="range" min="0.1" max="1" step="0.05" id="imOp" value="${ref.opacity}"></label>`;
    }
  }
  return s;
}
function drawPreview() {
  const cv = $('#prev'); if (!cv || !ref) return;
  const {img, an} = ref, scale = Math.min(1, 700 / img.height);
  cv.width = img.width * scale; cv.height = img.height * scale;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0, cv.width, cv.height);
  if (!an || an.error) return;
  const {rect, cols, rows} = an;
  cx.save(); cx.scale(scale, scale);
  cx.strokeStyle = '#FFDF5E'; cx.lineWidth = 3 / scale;
  cx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  cx.lineWidth = 1.2 / scale; cx.strokeStyle = 'rgba(255,223,94,.75)';
  for (let c = 1; c < cols; c++) { const x = rect.x + rect.w * c / cols; cx.beginPath(); cx.moveTo(x, rect.y); cx.lineTo(x, rect.y + rect.h); cx.stroke(); }
  for (let r = 1; r < rows; r++) { const y = rect.y + rect.h * r / rows; cx.beginPath(); cx.moveTo(rect.x, y); cx.lineTo(rect.x + rect.w, y); cx.stroke(); }
  cx.restore();
}

/* inspector events */
$('#pane').addEventListener('input', e => {
  const t = e.target, lv = L();
  if (t.dataset.lv) { lv[t.dataset.lv] = t.type === 'number' ? Math.max(0, +t.value || 0) : t.value; if (t.dataset.lv === 'id') { $('#lvTitle').textContent = lv.id; } commit(); return; }
  if (t.dataset.sol) { lv.solution = lv.solution || {minMoves: 0, traps: 0}; lv.solution[t.dataset.sol] = Math.max(0, +t.value || 0); commit(); return; }
  if (t.dataset.bnum && sel && sel.type === 'block') { const b = lv.blocks[sel.i], v = Math.max(0, +t.value || 0); if (v) b[t.dataset.bnum] = v; else delete b[t.dataset.bnum]; commit(); render(); return; }
  if ('sfreeze' in t.dataset && sel && sel.type === 'stud') { const s = lv.targets[sel.i], v = Math.max(0, +t.value || 0); if (v) s.freeze = v; else delete s.freeze; commit(); render(); return; }
  if (t.id === 'imOp') { ref.opacity = +t.value; render(); }
});
$('#pane').addEventListener('change', e => {
  const t = e.target, lv = L();
  if (t.dataset.size) { resizeBoard(t.dataset.size === 'w' ? +t.value : dims(lv).w, t.dataset.size === 'h' ? +t.value : dims(lv).h); return; }
  if ('bid' in t.dataset && sel && sel.type === 'block') {
    const v = t.value.trim();
    if (!v || lv.blocks.some((b, i) => i !== sel.i && b.id === v)) { toast('That id is empty or already used.'); t.value = lv.blocks[sel.i].id; return; }
    lv.blocks[sel.i].id = v; commit(); render(); return;
  }
  if (t.id === 'imShow') { ref.show = t.checked; render(); }
  if (t.id === 'imgFile' && t.files[0]) loadImage(t.files[0]);
});
$('#pane').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  const lv = L(), d = t.dataset;
  const b = sel && sel.type === 'block' ? lv.blocks[sel.i] : null, st = sel && sel.type === 'stud' ? lv.targets[sel.i] : null;
  if (d.bcolor && b) { b.color = d.bcolor; commit(); renderAll(); return; }
  if (d.bkind && b) { b.socketKind = d.bkind; if (d.bkind === 'axle') delete b.lockPin; commit(); renderAll(); return; }
  if ('axis' in d && b) { if (d.axis) b.axis = d.axis; else delete b.axis; commit(); renderAll(); return; }
  if ('lock' in d && b) { if (d.lock) b.lockPin = d.lock; else delete b.lockPin; commit(); renderAll(); return; }
  if ('spoon' in d && b) { if (d.spoon) b.spoon = d.spoon; else delete b.spoon; commit(); renderAll(); return; }
  if (d.scolor && st) { st.color = d.scolor; commit(); renderAll(); return; }
  if (d.skind && st) { st.kind = d.skind; commit(); renderAll(); return; }
  if (d.shift) { const [dx, dy] = d.shift.split(',').map(Number); shiftBoard(dx, dy); return; }
  switch (d.act) {
    case 'del': deleteSel(); break;
    case 'rotL': rotateSel(-1); break;
    case 'rotR': rotateSel(1); break;
    case 'flip': flipSel(); break;
    case 'dup': duplicateSel(); break;
    case 'solve': runSolver(); break;
    case 'stop': cancelSolver(); break;
    case 'saveSol': saveSolution(); break;
    case 'playSol': setMode('play'); hintPath = {key: stateKey(game), path: solverState.result.path.slice()}; banner('Press Next solver move or Auto play.', 'info'); break;
    case 'applyJson': applyJson(); break;
    case 'copyJson': copyJson(); break;
    case 'download': downloadLevel(); break;
    case 'reread': rereadImage(); break;
    case 'imNew': importImageLevel(true); break;
    case 'imReplace': importImageLevel(false); break;
  }
});

function resizeBoard(w, h) {
  const lv = L();
  w = Math.max(2, Math.min(16, w | 0)); h = Math.max(2, Math.min(18, h | 0));
  const rows = [];
  for (let y = 0; y < h; y++) { let r = ''; for (let x = 0; x < w; x++) r += (lv.board[y] && lv.board[y][x]) || '.'; rows.push(r); }
  const lost = lv.blocks.filter(b => b.cells.some(([x, y]) => x >= w || y >= h)).length + lv.targets.filter(t => t.at[0] >= w || t.at[1] >= h).length;
  lv.board = rows;
  lv.blocks = lv.blocks.filter(b => !b.cells.some(([x, y]) => x >= w || y >= h));
  lv.targets = lv.targets.filter(t => t.at[0] < w && t.at[1] < h);
  pruneJoints(lv);
  if (lost) toast(`${lost} block${lost > 1 ? 's' : ''} or stud${lost > 1 ? 's' : ''} outside the new size were removed.`);
  sel = null; commit(); renderAll();
}
function shiftBoard(dx, dy) {
  const lv = L(), {w, h} = dims(lv);
  const fits = ([x, y]) => x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h;
  if (!lv.blocks.every(b => b.cells.every(fits)) || !lv.targets.every(t => fits(t.at))) { toast('Something would fall off the board. Make the board bigger first.'); return; }
  const rows = []; for (let y = 0; y < h; y++) { let r = ''; for (let x = 0; x < w; x++) { const sx = x - dx, sy = y - dy; r += (sx >= 0 && sy >= 0 && sx < w && sy < h) ? lv.board[sy][sx] : '.'; } rows.push(r); }
  lv.board = rows;
  const mv = c => [c[0] + dx, c[1] + dy];
  lv.blocks.forEach(b => { b.cells = b.cells.map(mv); b.socket = mv(b.socket); });
  lv.targets.forEach(t => { t.at = mv(t.at); });
  (lv.joints || []).forEach(j => { j.a = mv(j.a); j.b = mv(j.b); });
  commit(); renderAll();
}

/* ---------- JSON in and out ---------- */
function parseLevels(text) {
  const d = JSON.parse(text), list = Array.isArray(d) ? d : (d && Array.isArray(d.levels) ? d.levels : [d]);
  list.forEach((lv, i) => {
    if (!lv || !Array.isArray(lv.board) || !Array.isArray(lv.blocks) || !Array.isArray(lv.targets)) throw new Error(`Item ${i + 1} is not a level/v1 level (it needs board, targets and blocks).`);
  });
  return list.map(lv => normalize(Object.assign({schema: 'level/v1', id: 'L0000', time: 60, reward: 20, solution: {minMoves: 0, traps: 0}}, lv)));
}
function applyJson() {
  const m = $('#jsonMsg');
  try {
    const [lv] = parseLevels($('#jsonText').value);
    levels[cur] = lv; sel = null; commit(); renderAll(); tab = 'json'; renderPane();
    $('#jsonMsg').textContent = 'Applied.'; $('#jsonMsg').className = 'msg ok';
  } catch (e) { m.textContent = e.message; m.className = 'msg bad'; }
}
async function copyText(s, what) {
  try { await navigator.clipboard.writeText(s); toast(what + ' copied.'); }
  catch (e) { openDialog('Copy ' + what, `<textarea class="code" readonly>${esc(s)}</textarea>`, '<button class="btn" data-close>Close</button>'); }
}
const copyJson = () => copyText(JSON.stringify(normalize(L()), null, 2), 'Level JSON');
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'})); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const downloadLevel = () => download(`${L().id}.json`, JSON.stringify(normalize(L()), null, 2));
function openImport() {
  openDialog('Import levels', `<p class="hint">Paste one level, a list of levels, or choose .json files. Levels with an id already in the list replace it. New ids are added at the end.</p>
  <textarea class="code" id="impText" placeholder='{"schema":"level/v1", ...}'></textarea>
  <p><input type="file" id="impFiles" accept=".json,application/json" multiple></p><div class="msg" id="impMsg"></div>`,
  '<button class="btn" data-close>Cancel</button><button class="btn primary" id="impGo">Import</button>');
  $('#impFiles').addEventListener('change', async e => {
    const texts = await Promise.all([...e.target.files].map(f => f.text()));
    const all = []; texts.forEach(t => { try { const d = JSON.parse(t); Array.isArray(d) ? all.push(...d) : all.push(d); } catch (err) {} });
    $('#impText').value = JSON.stringify(all, null, 2);
  });
  $('#impGo').addEventListener('click', () => {
    try {
      const list = parseLevels($('#impText').value); let added = 0, replaced = 0;
      list.forEach(lv => { const i = levels.findIndex(x => x.id === lv.id); if (i >= 0) { levels[i] = lv; replaced++; } else { levels.push(lv); added++; } });
      closeDialog(); persist(); selectLevel(levels.findIndex(x => x.id === list[0].id)); refreshList();
      toast(`${added} added, ${replaced} replaced.`);
    } catch (e) { $('#impMsg').textContent = e.message; $('#impMsg').className = 'msg bad'; }
  });
}

/* ---------- screenshot import ---------- */
function loadImage(file) {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    ref = {img, url, show: false, opacity: 0.5};
    readImage();
  };
  img.onerror = () => toast('Could not open that image.');
  img.src = url;
}
function pixels(img) {
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext('2d', {willReadFrequently: true}); cx.drawImage(img, 0, 0);
  return cx.getImageData(0, 0, img.width, img.height);
}
function readImage(opts) {
  const an = analyze(pixels(ref.img), opts);
  ref.an = an;
  if (!an.error) { const r = toLevel(an, L()); ref.level = r.level; ref.notes = r.notes; }
  tab = 'image'; renderPane();
}
function rereadImage() {
  const n = id => +$(id).value;
  readImage({cols: n('#imCols'), rows: n('#imRows'), rect: {x: n('#imX'), y: n('#imY'), w: n('#imW'), h: n('#imH')}});
}
function importImageLevel(asNew) {
  if (!ref || !ref.level) return;
  const lv = clone(ref.level);
  if (asNew) {
    let n = levels.length + 1, id; do { id = 'L' + String(n++).padStart(4, '0'); } while (levels.some(x => x.id === id));
    lv.id = id; levels.push(lv); persist(); selectLevel(levels.length - 1);
  } else { lv.id = L().id; levels[cur] = lv; sel = null; commit(); }
  ref.levelId = L().id; ref.show = false;
  tab = 'check'; renderAll();
  toast('Level built from the screenshot. Check the notes, then run the solver.');
}
document.addEventListener('paste', e => {
  const f = [...(e.clipboardData || {}).items || []].find(i => i.type.startsWith('image/'));
  if (f && !e.target.closest('textarea,input')) { e.preventDefault(); loadImage(f.getAsFile()); }
});
$('#pane').addEventListener('dragover', e => { const d = e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
$('#pane').addEventListener('dragleave', e => { const d = e.target.closest('#drop'); if (d) d.classList.remove('over'); });
$('#pane').addEventListener('drop', e => { const d = e.target.closest('#drop'); if (!d) return; e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) loadImage(f); });

/* ---------- dialog, toast, banner ---------- */
function openDialog(title, body, foot) { $('#dlgTitle').textContent = title; $('#dlgBody').innerHTML = body; $('#dlgFoot').innerHTML = foot; $('#modal').hidden = false; }
function closeDialog() { $('#modal').hidden = true; }
$('#dlgX').addEventListener('click', closeDialog);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeDialog(); });
let toastT = 0;
function toast(s) { const t = $('#toast'); t.textContent = s; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); }
function banner(s, kind) { const b = $('#banner'); b.hidden = !s; b.textContent = s; b.className = 'banner ' + (kind || 'info'); }

/* ---------- wiring ---------- */
function renderAll() {
  $('#lvTitle').textContent = L().id;
  render(); renderPane(); refreshList(); refreshBadge(); syncUndo(); if (mode === 'play') hud();
}
$('#tools').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
$('#paintColors').addEventListener('click', e => { const b = e.target.closest('[data-col]'); if (b) setPaint(b.dataset.col); });
$('#paintKind').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (b) { paint.kind = b.dataset.kind; savePrefs(); renderTools(); } });
function setPaint(c) {
  paint.color = c; savePrefs(); renderTools();
  /* recolor the selection too, like picking a swatch in the inspector */
  if (sel && mode === 'edit' && tool === 'select') { const lv = L(); if (sel.type === 'block') lv.blocks[sel.i].color = c; else lv.targets[sel.i].color = c; commit(); renderAll(); }
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; savePrefs(); renderPane(); } });
$('#lvList').addEventListener('click', e => { const b = e.target.closest('.lv'); if (b) selectLevel(+b.dataset.i); });
$('#lvSearch').addEventListener('input', refreshList);
$('#lvNew').addEventListener('click', () => {
  let n = levels.length + 1, id; do { id = 'L' + String(n++).padStart(4, '0'); } while (levels.some(x => x.id === id));
  levels.push(blankLevel(id, 7, 8)); persist(); selectLevel(levels.length - 1); setTool('block');
});
$('#lvDup').addEventListener('click', () => { const c = clone(L()); c.id = L().id + '_copy'; levels.splice(cur + 1, 0, c); persist(); selectLevel(cur + 1); });
$('#lvUp').addEventListener('click', () => { if (cur < 1) return; [levels[cur - 1], levels[cur]] = [levels[cur], levels[cur - 1]]; cur--; persist(); refreshList(); });
$('#lvDown').addEventListener('click', () => { if (cur >= levels.length - 1) return; [levels[cur + 1], levels[cur]] = [levels[cur], levels[cur + 1]]; cur++; persist(); refreshList(); });
function armed(btn, fn) {
  if (btn.classList.contains('armed')) { btn.classList.remove('armed'); btn.textContent = btn.dataset.label; fn(); return; }
  btn.dataset.label = btn.textContent; btn.classList.add('armed'); btn.textContent = 'Sure?';
  setTimeout(() => { if (btn.classList.contains('armed')) { btn.classList.remove('armed'); btn.textContent = btn.dataset.label; } }, 2500);
}
$('#lvDel').addEventListener('click', e => armed(e.currentTarget, () => { if (levels.length < 2) { toast('Keep at least one level.'); return; } levels.splice(cur, 1); cur = Math.min(cur, levels.length - 1); persist(); selectLevel(cur); }));
$('#btnReset').addEventListener('click', e => armed(e.currentTarget, () => { levels = clone(SAMPLES); cur = 0; persist(); selectLevel(0); toast('Back to the game levels.'); }));
$('#btnImport').addEventListener('click', openImport);
$('#btnExportAll').addEventListener('click', () => download('jelly_block_levels.json', JSON.stringify(levels.map(normalize), null, 2)));
$('#tUndo').addEventListener('click', doUndo);
$('#tRedo').addEventListener('click', doRedo);
$('#tCopy').addEventListener('click', copyJson);
$('#tDownload').addEventListener('click', downloadLevel);
$('#modeEdit').addEventListener('click', () => setMode('edit'));
$('#modePlay').addEventListener('click', () => setMode('play'));
$('#pUndo').addEventListener('click', playUndo);
$('#pRestart').addEventListener('click', () => { stopAuto(); startGame(); render(); });
$('#pHint').addEventListener('click', () => { stopAuto(); hintMove(false); });
$('#pAuto').addEventListener('click', () => { if (autoTimer) { stopAuto(); return; } $('#pAuto').setAttribute('aria-pressed', 'true'); hintMove(true); });
$('#bHand').addEventListener('click', () => { booster = booster === 'hand' ? null : 'hand'; syncBoosters(); banner(booster ? 'Hand: tap a block to remove it.' : '', 'info'); });
$('#bMagnet').addEventListener('click', () => { booster = booster === 'magnet' ? null : 'magnet'; syncBoosters(); banner(booster ? 'Magnet: tap a stud.' : '', 'info'); });
$('#bFreeze').addEventListener('click', () => { timer.frozenUntil = Math.max(performance.now(), timer.frozenUntil) + 30000; boostUse.freeze++; syncBoosters(); hud(); toast('Timer stopped for 30 s.'); });

document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select') || !$('#modal').hidden) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); if (mode === 'play') playUndo(); else if (e.shiftKey) doRedo(); else doUndo(); return; }
  if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
  if (ctrl && k.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); return; }
  if (ctrl) return;
  if (k === 'p' || k === 'P') { setMode(mode === 'edit' ? 'play' : 'edit'); return; }
  if (mode === 'play') { if (k === 'r') { startGame(); render(); } if (k === 'h') hintMove(false); return; }
  const t = TOOLS.find(t => t.key.toLowerCase() === k.toLowerCase());
  if (t && !(k === 'R' || k === 'r')) { setTool(t.id); return; }
  if (/^[1-8]$/.test(k)) { setPaint(COLORS[+k - 1].key); return; }
  if (k === 'x' || k === 'X') { paint.kind = paint.kind === 'round' ? 'axle' : 'round'; savePrefs(); renderTools(); return; }
  if (k === 'r' || k === 'R') { rotateSel(e.shiftKey ? -1 : 1); return; }
  if (k === 'f' || k === 'F') { flipSel(); return; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSel(); return; }
  if (k === 'Escape') { sel = null; linkFrom = null; renderAll(); return; }
  const arrows = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
  if (arrows[k]) { e.preventDefault(); nudgeSel(...arrows[k]); }
});

load();
renderTools();
resetHistory();
renderAll();
