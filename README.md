# Jelly Block Level Builder

A level editor for Jelly Block. It reads and writes the game's `level/v1` JSON. Game levels 1–10 are preloaded in the list on the left.

Live page: https://hvtanh07.github.io/jelly-block-level-builder/

## Run it

You need Node.js 20 or newer.

```sh
npm install
npm run dev      # opens the editor at http://localhost:5173
npm test         # solves the sample levels and checks the screenshot import
npm run build    # writes dist/index.html, one file that opens without a server
```

## Features

- **Build:** draw blocks cell by cell, place the hole, studs, walls, missing cells and links. Drag, nudge, rotate, flip and duplicate blocks. Undo and redo.
- **Config:** level id, time, reward, board size, and every element on the selected block or stud: Arrow Block (`axis`), Hidden Block (`cover`), X Stud and X hole (`kind` / `socketKind: "axle"`), Linked Block (`joints`), Spoon Lock (`lockPin`, `spoon`), Frozen Block (`freeze` on a block), Frozen Stud (`freeze` on a stud).
- **Play test:** drag blocks like in the game, with the timer, Take back, Restart, and the Hand, Magnet and Time Freeze boosters. "Next solver move" and "Auto play" play the solver's moves from the current board.
- **Solver:** checks the level is solvable, finds the fewest moves, and counts traps. "Save to solution" writes `solution.minMoves` and `solution.traps`. The level list flags data errors.
- **Image import:** drop or paste a game screenshot. The tool finds the board, the grid, blocks, holes (round or X), studs, walls and arrow blocks, and builds a level. Hidden-block colors, the numbers on hidden and frozen pieces, and ice are not read yet: set those by hand. The screenshot can stay behind the board to check the result.
- **JSON:** edit one level's JSON, import one or many levels, export one level or all levels.

Edits are saved in the browser's local storage. Export them before clearing site data.

## Rules the editor and solver use

From the Jelly Block GDD (1.2 and 1.4). The solver gets the saved `minMoves` and `traps` of all 7 element sample levels (`npm test`).

- Coordinates are `[x, y]`, from the top-left cell. Board rows: `.` open cell, `W` wall, `#` no cell.
- One move is one drag of a block, or of a linked group, to any place it can reach cell by cell. Blocks do not pass walls, other blocks or studs.
- A block clears when its hole lands on a stud of the same color and shape. The drag stops there.
- When every block of a color has cleared, the studs of that color clear too.
- `cover`, `freeze` (block) and `freeze` (stud) count down by one for every block cleared. A hidden block cannot clear, a frozen block cannot move, a frozen stud blocks like a wall.
- A block with `lockPin` cannot move until a block holding a `spoon` of that color clears.
- Linked blocks move together. A frozen or locked member holds the whole group. Links go when a block they join clears.
- Traps: first moves from the start board after which the level can no longer be solved.

## Code

- `src/engine.js`: rules, play test, checks and the solver.
- `src/vision.js`: screenshot to level.
- `src/main.js`: the editor UI. `src/worker.js` runs the solver in the background.
- `src/data/levels.json`: game levels 1–10, read from game screenshots. `tests/fixtures/element_samples.json`: the 7 element sample levels the solver tests use.
- `tests/`: Vitest tests for the solver and the screenshot import.
