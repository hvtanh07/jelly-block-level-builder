/* Screenshot import: turn a Jelly Block game screenshot into level data.
   Works on raw RGBA pixels ({width, height, data}) so it runs in the browser and in tests.
   Steps: find the board frame, find the cell size, then read each cell (block, hole, stud, wall, arrow, stone cover)
   and join neighbouring cells of one color into blocks where no gap separates them. */
import {COLORS, nextBlockId, normalize} from './engine.js';

export function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx / 255];
}
/* hue as drawn in the game, where it differs from the swatch hex: game green is a darker grass green, mint is the light green */
const GAME_HUE = {green: 106, mint: 139};
const HUES = COLORS.map(c => { const n = parseInt(c.hex.slice(1), 16); return {key: c.key, h: GAME_HUE[c.key] ?? hsv(n >> 16, (n >> 8) & 255, n & 255)[0]}; });
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
export function nearestColor(h) { let best = null, bd = 1e9; HUES.forEach(c => { const d = hueDist(h, c.h); if (d < bd) { bd = d; best = c.key; } }); return best; }

/* pixel classes */
const SAT = 1, FRAME = 2, DARK = 3, WHITE = 4, GREY = 5, OTHER = 0;
function classOf(r, g, b) {
  const [h, s, v] = hsv(r, g, b);
  if (v > 0.85 && s < 0.18) return WHITE;
  if (s > 0.5 && v > 0.6 && !(h > 232 && h < 262 && v < 0.8)) return SAT;
  if (h > 232 && h < 262 && s > 0.4 && v > 0.56 && v <= 0.8) return FRAME;
  if (s < 0.25 && v > 0.25 && v < 0.75) return GREY;
  if (v < 0.56) return DARK;
  return OTHER;
}

export function analyze(img, opts) {
  opts = opts || {};
  const {width: W, height: H, data} = img;
  const cls = new Uint8Array(W * H), hue = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    cls[i] = classOf(r, g, b);
    if (cls[i] === SAT) hue[i] = hsv(r, g, b)[0];
  }
  const rect = opts.rect || findBoard(cls, W, H);
  if (!rect) return {error: 'Could not find the board frame. Draw the board box by hand.'};
  const grid = opts.cols && opts.rows ? {cols: opts.cols, rows: opts.rows} : findGrid(cls, W, rect);
  const res = readCells(cls, hue, W, rect, grid.cols, grid.rows);
  return {rect, cols: grid.cols, rows: grid.rows, ...res};
}

/* the board frame is the largest connected patch of frame-colored pixels */
function findBoard(cls, W, H) {
  const step = 2, w = Math.ceil(W / step), h = Math.ceil(H / step), m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = cls[(y * step) * W + x * step] === FRAME ? 1 : 0;
  const lab = new Int32Array(w * h).fill(-1);
  let best = null;
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; const st = [s]; lab[s] = s;
    while (st.length) {
      const c = st.pop(), cx = c % w, cy = (c / w) | 0; n++;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (const nb of [c - 1, c + 1, c - w, c + w]) {
        if (nb < 0 || nb >= w * h || lab[nb] >= 0 || !m[nb]) continue;
        if ((nb === c - 1 && cx === 0) || (nb === c + 1 && cx === w - 1)) continue;
        lab[nb] = s; st.push(nb);
      }
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area > best.area) best = {area, x0, y0, x1, y1, id: s};
  }
  if (!best || best.area < (w * h) / 30) return null;
  let {x0, y0, x1, y1} = best;
  x0 *= step; y0 *= step; x1 *= step; y1 *= step;
  /* step inward from each side, along several lines, until the frame ends */
  const inward = (sx, sy, dx, dy) => {
    let x = sx, y = sy, k = 0;
    while (k < 400 && cls[y * W + x] !== FRAME) { x += dx; y += dy; k++; }
    while (k < 400 && cls[y * W + x] === FRAME) { x += dx; y += dy; k++; }
    return k < 400 ? (dx ? x : y) : null;
  };
  const med = a => { a = a.filter(v => v != null).sort((p, q) => p - q); return a.length ? a[a.length >> 1] : null; };
  const fr = [0.2, 0.35, 0.5, 0.65, 0.8];
  const L = med(fr.map(f => inward(x0, Math.round(y0 + f * (y1 - y0)), 1, 0)));
  const R = med(fr.map(f => inward(x1, Math.round(y0 + f * (y1 - y0)), -1, 0)));
  const T = med(fr.map(f => inward(Math.round(x0 + f * (x1 - x0)), y0, 0, 1)));
  const B = med(fr.map(f => inward(Math.round(x0 + f * (x1 - x0)), y1, 0, -1)));
  if ([L, R, T, B].some(v => v == null) || R - L < 40 || B - T < 40) return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
  return {x: L, y: T, w: R - L + 1, h: B - T + 1};
}

/* Cell size: block edges line up with the grid, so pick the column count whose grid best matches where colored runs start and end. */
function findGrid(cls, W, rect) {
  const runs = [];
  for (let k = 1; k < 40; k++) {
    const y = Math.round(rect.y + rect.h * k / 40);
    let s = -1;
    for (let x = rect.x; x <= rect.x + rect.w; x++) {
      const on = x < rect.x + rect.w && (cls[y * W + x] === SAT || cls[y * W + x] === GREY);
      if (on && s < 0) s = x;
      if (!on && s >= 0) { runs.push([s - rect.x, x - rect.x]); s = -1; }
    }
  }
  let best = null;
  for (let n = 4; n <= 14; n++) {
    const c = rect.w / n, rows = Math.max(1, Math.round(rect.h / c));
    const long = runs.filter(([a, b]) => b - a > 0.6 * c);
    if (!long.length) continue;
    let err = 0;
    long.forEach(([a, b]) => { const fa = (a / c) % 1, fb = (b / c) % 1; err += Math.min(fa, 1 - fa) + Math.min(fb, 1 - fb); });
    err = err / long.length + Math.abs(rect.h / c - rows) * 0.5;
    if (!best || err < best.err - 1e-3) best = {err, cols: n, rows};
  }
  return best || {cols: 7, rows: Math.round(7 * rect.h / rect.w)};
}

function readCells(cls, hue, W, rect, cols, rows) {
  const cw = rect.w / cols, ch = rect.h / rows, s = Math.min(cw, ch);
  const center = (c, r) => [rect.x + (c + 0.5) * cw, rect.y + (r + 0.5) * ch];
  const at = (x, y) => (Math.round(y) * W + Math.round(x));
  /* sample a ring of points around a center: returns class counts and the hues of colored points */
  const ring = (cx, cy, r0, r1, n) => {
    const out = {n: 0, c: [0, 0, 0, 0, 0, 0], hues: []};
    for (let rr = r0; rr <= r1 + 1e-9; rr += (r1 - r0) / 2 || 1) for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, j = at(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      out.n++; out.c[cls[j]]++; if (cls[j] === SAT) out.hues.push(hue[j]);
      if (r0 === r1) break;
    }
    return out;
  };
  const pts = (cx, cy, list) => { const o = {n: 0, c: [0, 0, 0, 0, 0, 0], hues: []}; list.forEach(([dx, dy]) => { const j = at(cx + dx * s, cy + dy * s); o.n++; o.c[cls[j]]++; if (cls[j] === SAT) o.hues.push(hue[j]); }); return o; };
  const hueMode = hs => { if (!hs.length) return null; const m = {}; hs.forEach(h => { const k = nearestColor(h); m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1])[0][0]; };

  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const [cx, cy] = center(c, r);
    /* the fill sits between the hole and the cell edge, so look at the cell's corners region */
    const fill = pts(cx, cy, [[-.36, -.36], [.36, -.36], [-.36, .36], [.36, .36], [0, -.4], [0, .4], [-.4, 0], [.4, 0], [-.3, -.2], [.3, .2], [-.2, .3], [.2, -.3]]);
    const mid = pts(cx, cy, [[0, 0], [.05, 0], [-.05, 0], [0, .05], [0, -.05], [.08, .08], [-.08, -.08], [.08, -.08], [-.08, .08]]);
    const diag = pts(cx, cy, [[.13, .13], [-.13, -.13], [.13, -.13], [-.13, .13]]);
    const axes = pts(cx, cy, [[.15, 0], [-.15, 0], [0, .15], [0, -.15]]);
    const cell = {c, r, type: 'empty'};
    if (fill.c[SAT] / fill.n >= 0.6) {
      cell.type = 'block'; cell.color = hueMode(fill.hues);
      if (mid.c[SAT] + mid.c[WHITE] <= 3) {
        cell.hole = 'round';
        /* X hole: dark along the diagonals, colored along the axes */
        if (axes.c[SAT] >= 3 && diag.c[DARK] + diag.c[FRAME] >= 3) cell.hole = 'axle';
      }
      if (mid.c[WHITE] + pts(cx, cy, [[0, .2], [0, -.2], [.2, 0], [-.2, 0]]).c[WHITE] >= 4) {
        const v = pts(cx, cy, [[0, .25], [0, -.25], [0, .32], [0, -.32]]).c[WHITE], hh = pts(cx, cy, [[.25, 0], [-.25, 0], [.32, 0], [-.32, 0]]).c[WHITE];
        cell.arrow = v >= hh ? 'vertical' : 'horizontal';
      }
    } else if (fill.c[GREY] / fill.n >= 0.6) {
      cell.type = 'stone';
      if (mid.c[DARK] >= 6) cell.hole = 'round';
    } else if (mid.c[SAT] >= 5 || (diag.c[SAT] >= 3 && fill.c[SAT] <= 2)) {
      cell.type = 'stud'; cell.color = hueMode(mid.hues.concat(diag.hues));
      cell.kind = (diag.c[SAT] >= 3 && mid.c[SAT] >= 3 && pts(cx, cy, [[.2, 0], [-.2, 0], [0, .2], [0, -.2]]).c[SAT] <= 1) ? 'axle' : 'round';
    } else if (fill.c[FRAME] / fill.n >= 0.25 || ring(cx, cy, s * 0.3, s * 0.3, 16).c[FRAME] >= 8) {
      cell.type = 'wall';
    }
    cells.push(cell);
  }
  /* two neighbouring cells belong to one block when the color runs across their shared edge with no gap */
  const joined = (a, b) => {
    const [ax, ay] = center(a.c, a.r), [bx, by] = center(b.c, b.r), mx = (ax + bx) / 2, my = (ay + by) / 2;
    /* sample lines across the edge, away from the middle where an arrow or a number can sit */
    const horiz = a.r === b.r, n = 9, want = a.type === 'stone' ? GREY : SAT, offs = [-0.32, -0.22, 0.22, 0.32];
    let ok = 0;
    for (const off of offs) for (let i = 0; i < n; i++) {
      const t = (i / (n - 1) - 0.5) * 0.24 * s;
      const x = horiz ? mx + t : mx + off * s, y = horiz ? my + off * s : my + t, k = cls[at(x, y)];
      if (k === want || k === WHITE) ok++;
    }
    return ok >= n * offs.length * 0.85;
  };
  const idx = (c, r) => r * cols + c;
  const parent = cells.map((_, i) => i), find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  cells.forEach(a => {
    if (a.type !== 'block' && a.type !== 'stone') return;
    [[1, 0], [0, 1]].forEach(([dc, dr]) => {
      if (a.c + dc >= cols || a.r + dr >= rows) return;
      const b = cells[idx(a.c + dc, a.r + dr)];
      if (b.type !== a.type || (a.type === 'block' && b.color !== a.color)) return;
      if (joined(a, b)) parent[find(idx(a.c, a.r))] = find(idx(b.c, b.r));
    });
  });
  const grp = new Map();
  cells.forEach((a, i) => { if (a.type === 'block' || a.type === 'stone') { const k = find(i); if (!grp.has(k)) grp.set(k, []); grp.get(k).push(a); } });
  return {cells, pieces: [...grp.values()], cw, ch};
}

/* Build a level/v1 object from an analysis. Stone (hidden) blocks get a placeholder color and cover, to fix by hand. */
export function toLevel(an, base) {
  const lv = {schema: 'level/v1', id: (base && base.id) || 'L0000', time: (base && base.time) || 120, reward: (base && base.reward) || 30,
    board: [], targets: [], blocks: [], solution: {minMoves: 0, traps: 0}};
  const {cols, rows, cells} = an, notes = [];
  for (let r = 0; r < rows; r++) { let s = ''; for (let c = 0; c < cols; c++) s += cells[r * cols + c].type === 'wall' ? 'W' : '.'; lv.board.push(s); }
  cells.forEach(a => { if (a.type === 'stud') lv.targets.push({at: [a.c, a.r], color: a.color, kind: a.kind}); });
  const used = {};
  an.pieces.forEach(p => {
    const stone = p[0].type === 'stone';
    let color = p[0].color;
    if (stone) {
      /* guess the hidden color: a stud color with fewer blocks than studs */
      const count = c => lv.blocks.filter(b => b.color === c).length + (used[c] || 0);
      const studColors = lv.targets.map(t => t.color);
      color = studColors.find(c => count(c) === 0) || studColors[0] || 'red';
      used[color] = (used[color] || 0) + 1;
    }
    const holes = p.filter(a => a.hole);
    let sock = holes[0];
    if (!sock) {
      /* no hole seen: take a corner cell (the GDD puts the hole in a corner cell) */
      sock = p.slice().sort((a, b) => (a.r - b.r) || (a.c - b.c))[0];
      notes.push(`${stone ? 'Hidden block' : 'Block'} at ${sock.c},${sock.r}: no hole found, put it on a corner cell. Check it.`);
    }
    if (holes.length > 1) notes.push(`Block at ${sock.c},${sock.r}: found ${holes.length} holes in one piece. It may be two blocks.`);
    const b = {id: '', color, cells: p.map(a => [a.c, a.r]), socket: [sock.c, sock.r], socketKind: sock.hole || 'round'};
    b.cells.sort((x, y) => (x[0] === sock.c && x[1] === sock.r) ? -1 : (y[0] === sock.c && y[1] === sock.r) ? 1 : 0);
    const arrow = p.find(a => a.arrow);
    if (arrow) b.axis = arrow.arrow;
    if (stone) { b.cover = 1; notes.push(`Hidden block at ${sock.c},${sock.r}: set its real color and the number on it (cover). The import guessed ${color}, cover 1.`); }
    b.id = nextBlockId(lv, color);
    lv.blocks.push(b);
  });
  return {level: normalize(lv), notes};
}
