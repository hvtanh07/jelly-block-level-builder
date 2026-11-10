import {describe, it, expect} from 'vitest';
import {PNG} from 'pngjs';
import fs from 'fs';
import {analyze, toLevel} from '../src/vision.js';
import {check} from '../src/engine.js';

/* Level 27 from the game: 9 × 10 board, read by eye from the screenshot */
describe('screenshot import', () => {
  const img = PNG.sync.read(fs.readFileSync(new URL('./fixtures/level27_screenshot.png', import.meta.url)));
  const an = analyze(img), {level} = toLevel(an);
  const blockAt = (x, y) => level.blocks.find(b => b.cells.some(c => c[0] === x && c[1] === y));
  it('finds the 9 × 10 grid', () => { expect([an.cols, an.rows]).toEqual([9, 10]); });
  it('reads the walls', () => { expect(level.board).toEqual(['.........', '.........', '.........', '.........', '...W.W...', '.........', '....W....', '....W....', '.........', '.........']); });
  it('reads the studs', () => {
    const s = level.targets.map(t => `${t.at[0]},${t.at[1]} ${t.color}`).sort();
    expect(s).toEqual(['0,5 cyan', '2,0 orange', '4,0 blue', '4,9 red', '5,6 yellow', '6,0 green', '3,6 purple', '8,5 cyan'].sort());
  });
  it('joins cells into the right blocks', () => {
    expect(level.blocks.length).toBe(24);
    expect(blockAt(4, 3).cells.length).toBe(4);              // red T
    expect(blockAt(4, 3).socket).toEqual([4, 4]);
    expect(blockAt(6, 2)).not.toBe(blockAt(5, 3));            // red bar next to the red T is its own block
    expect(blockAt(0, 8).cells.length).toBe(4);              // red square
    expect(blockAt(2, 8).axis).toBe('vertical');             // green arrow block
    expect(blockAt(2, 8).cells.length).toBe(2);
    expect(blockAt(3, 0).cover).toBe(1);                     // stone = hidden block
  });
  it('gives level data without errors other than the hidden-block guesses', () => {
    const errs = check(level).filter(i => i.lvl === 'bad');
    expect(errs).toEqual([]);
  });
});
