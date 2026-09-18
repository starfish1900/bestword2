import { describe, expect, it } from 'vitest';
import type { Board, Letter } from '@bestword/contracts';
import { clearDraft, clickSquare, emptyDraft, eraseLetter, inferMove, typeLetter } from './draft';
const vowels = { A:16, E:24, I:16, O:13, U:13, Y:8 };
const board = (): Board => Array<Letter | null>(225).fill(null);
describe('move entry from the original specification', () => {
  it('infers MASTERPIECE around two typed letters and backspace returns across existing suffix', () => {
    const cells = board(); 'MAST'.split('').forEach((s, i) => { cells[30 + i] = s as Letter; });
    'PIECE'.split('').forEach((s, i) => { cells[36 + i] = s as Letter; });
    let draft = clickSquare(emptyDraft(), cells, 34);
    draft = typeLetter(draft, cells, 'E', ['R'], vowels).draft;
    draft = typeLetter(draft, cells, 'R', ['R'], vowels).draft;
    expect(draft.cursor).toBe(41);
    expect(inferMove(draft, cells)).toEqual({ type:'PLACE_WORD', row:2, column:0, direction:'H', word:'MASTERPIECE' });
    expect(eraseLetter(draft).cursor).toBe(35);
    expect(cells[34]).toBeNull();
  });
  it('toggles on each empty click, clears letters, ignores occupied clicks for alternation', () => {
    const cells = board(); cells[1] = 'A';
    let draft = clickSquare(emptyDraft(), cells, 0);
    draft = typeLetter(draft, cells, 'B', ['B'], vowels).draft;
    expect(draft.cursor).toBe(2);
    draft = clickSquare(draft, cells, 1);
    expect(draft.tiles).toEqual([]); expect(draft.cursor).toBe(2); expect(draft.clicks).toBe(1);
    draft = clickSquare(draft, cells, 2); expect(draft.direction).toBe('V');
    expect(clickSquare(draft, cells, 14).direction).toBe('H');
  });
  it('reserves each consonant and vowel without consuming original inventory', () => {
    const cells = board(); const rack: Letter[] = ['B'];
    let draft = clickSquare(emptyDraft(), cells, 0);
    draft = typeLetter(draft, cells, 'B', rack, vowels).draft;
    expect(typeLetter(draft, cells, 'B', rack, vowels).error).toMatch(/rack/);
    draft = typeLetter(draft, cells, 'Y', rack, { ...vowels, Y:1 }).draft;
    expect(typeLetter(draft, cells, 'Y', rack, { ...vowels, Y:1 }).error).toMatch(/vowels/);
    expect(rack).toEqual(['B']); expect(vowels.Y).toBe(8);
    expect(typeLetter(eraseLetter(draft), cells, 'Y', rack, { ...vowels, Y:1 }).error).toBeNull();
  });
  it('never wraps horizontal input to the next row and permits backspace at the edge', () => {
    const cells = board(); let draft = clickSquare(emptyDraft(), cells, 14);
    draft = typeLetter(draft, cells, 'A', [], vowels).draft;
    expect(draft.cursor).toBeNull(); expect(typeLetter(draft, cells, 'A', [], vowels).error).toMatch(/edge/);
    expect(eraseLetter(draft).cursor).toBe(14);
  });
  it('infers vertical prefixes/suffixes and jumps over occupied cells', () => {
    const cells = board(); cells[0] = 'C'; cells[30] = 'R';
    let draft = clickSquare(clickSquare(emptyDraft(), cells, 15), cells, 15);
    draft = typeLetter(draft, cells, 'A', [], vowels).draft; expect(draft.cursor).toBe(45);
    draft = typeLetter(draft, cells, 'E', [], vowels).draft;
    expect(inferMove(draft, cells)?.word).toBe('CARE');
    expect(clearDraft(draft).cursor).toBe(15);
  });
});
