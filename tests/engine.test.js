import {describe, it, expect} from 'vitest';
import LEVELS from './fixtures/element_samples.json';
import GAME from '../src/data/levels.json';
import {solve, countTraps, check, newGame, reach, groups, applyMove, won, normalize} from '../src/engine.js';

describe('sample levels', () => {
  for (const lv of LEVELS) {
    it(`${lv.id} has no data errors`, () => {
      expect(check(lv).filter(i => i.lvl === 'bad')).toEqual([]);
    });
    it(`${lv.id} solves in the saved minMoves (${lv.solution.minMoves})`, () => {
      const r = solve(lv);
      expect(r.status).toBe('solved');
      expect(r.moves).toBe(lv.solution.minMoves);
      /* the path replays to a win */
      const g = newGame(lv);
      r.path.forEach(m => applyMove(g, m.members, m.dx, m.dy, m.clear));
      expect(won(g)).toBe(true);
    });
    it(`${lv.id} has the saved number of traps (${lv.solution.traps})`, () => {
      expect(countTraps(lv).traps).toBe(lv.solution.traps);
    }, 30000);
    it(`${lv.id} keeps its JSON shape when normalized`, () => {
      expect(normalize(lv)).toEqual(lv);
    });
  }
});

describe('rules', () => {
  const lv = LEVELS.find(l => l.id === 'L0029');   // frozen block level
  it('a frozen block cannot move', () => {
    const g = newGame(lv), i = lv.blocks.findIndex(b => b.freeze);
    expect(reach(g, [i])).toEqual([]);
  });
  it('an arrow block moves on its axis only', () => {
    const al = LEVELS.find(l => l.id === 'L0022'), g = newGame(al), i = al.blocks.findIndex(b => b.axis === 'vertical');
    reach(g, [i]).forEach(m => expect(m.dx).toBe(0));
  });
  it('linked blocks move as one group', () => {
    const ll = LEVELS.find(l => l.id === 'L0017'), g = newGame(ll);
    expect(groups(g).some(gr => gr.length > 1)).toBe(true);
  });
  it('a locked block waits for its spoon', () => {
    const sl = LEVELS.find(l => l.id === 'L0032'), g = newGame(sl), i = sl.blocks.findIndex(b => b.lockPin);
    expect(reach(g, [i])).toEqual([]);
  });
  it('flags a block with no stud of its color', () => {
    const bad = JSON.parse(JSON.stringify(LEVELS[0]));
    bad.targets = bad.targets.filter(t => t.color !== 'pink');
    expect(check(bad).some(i => i.lvl === 'bad' && /never clear/.test(i.t))).toBe(true);
    expect(solve(bad).status).toBe('unsolvable');
  });
});

describe('game levels in the builder', () => {
  it('has levels L0001 to L0040', () => { expect(GAME.map(l => l.id)).toEqual([...Array(40)].map((_, i) => 'L' + String(i + 1).padStart(4, '0'))); });
  /* levels where the shortest-path search finishes: the saved minMoves must be the shortest */
  const EXACT = new Set(['L0001', 'L0002', 'L0003', 'L0004', 'L0005', 'L0006', 'L0007', 'L0008', 'L0009', 'L0010', 'L0011', 'L0012', 'L0013', 'L0014', 'L0015', 'L0017', 'L0021', 'L0031', 'L0040']);
  for (const lv of GAME) {
    it(`${lv.id} has no data problems`, () => { expect(check(lv)).toEqual([]); });
    if (EXACT.has(lv.id)) it(`${lv.id} solves in its saved minMoves (${lv.solution.minMoves})`, () => {
      const r = solve(lv);
      expect(r.status).toBe('solved');
      expect(r.moves).toBe(lv.solution.minMoves);
    });
  }
});

describe('hard flag', () => {
  const base = {schema: 'level/v1', id: 'L0005', time: 110, reward: 50, board: ['..'], targets: [], blocks: [], solution: {minMoves: 0, traps: 0}};
  it('writes hard: true right after reward when the level is marked hard', () => {
    expect(Object.keys(normalize({...base, hard: true})).slice(0, 6)).toEqual(['schema', 'id', 'time', 'reward', 'hard', 'board']);
    expect(normalize({...base, hard: true}).hard).toBe(true);
  });
  it('leaves hard out when the level is not hard', () => {
    expect('hard' in normalize(base)).toBe(false);
    expect('hard' in normalize({...base, hard: false})).toBe(false);
  });
});
