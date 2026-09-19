import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluatePlacement } from '@bestword/engine';
import { Gaddag } from '@bestword/lexicon';
import type { Letter, PlaceWordAction } from '@bestword/contracts';
import { findBestMove, type AiPosition, type SearchLexicon } from '../src/index.js';
import { action, dictionary, engineState, fixture, key } from './helpers.js';

function oracle(position: AiPosition, words: readonly string[], lexicon: SearchLexicon): Map<string, number> {
  const result = new Map<string, number>(), state = engineState(position);
  for (const word of words) for (const direction of ['H', 'V'] as const) for (let row = 0; row < 15; row++) for (let column = 0; column < 15; column++) {
    if ((direction === 'H' ? column : row) + word.length > 15) continue;
    let conflict = false, touches = false;
    for (let offset = 0; offset < word.length; offset++) {
      const r = row + (direction === 'V' ? offset : 0), c = column + (direction === 'H' ? offset : 0), old = position.board[r * 15 + c];
      if (old && old !== word[offset]) { conflict = true; break; }
      if (old || (r > 0 && position.board[(r - 1) * 15 + c]) || (r < 14 && position.board[(r + 1) * 15 + c]) || (c > 0 && position.board[r * 15 + c - 1]) || (c < 14 && position.board[r * 15 + c + 1])) touches = true;
    }
    if (conflict || !touches) continue;
    const move: PlaceWordAction = { type: 'PLACE_WORD', row, column, direction, word };
    try { result.set(key(move), evaluatePlacement(state, 0, move, lexicon).score); } catch { /* Independently rejected by the authoritative engine. */ }
  }
  return result;
}
function compare(position: AiPosition, words: readonly string[]): void {
  const graph = dictionary(words), expected = oracle(position, words, graph), actual = new Map<string, number>();
  const original = JSON.stringify(position);
  const result = findBestMove(position, graph, { onMove: (move, score) => { expect(actual.has(key(move)), `Duplicate ${key(move)}`).toBe(false); actual.set(key(move), score); } });
  expect([...actual].sort()).toEqual([...expected].sort());
  expect(result.complete).toBe(true);
  const ordered = [...expected].sort(([a, as], [b, bs]) => bs - as || (a < b ? -1 : a > b ? 1 : 0));
  expect(result.move ? key(result.move) : null).toBe(ordered[0]?.[0] ?? null);
  expect(result.score).toBe(ordered[0]?.[1] ?? 0);
  expect(JSON.stringify(position)).toBe(original);
}

describe('streaming anchor + cross-check GADDAG generator', () => {
  const examples: [string, [string, string][], string, string, string[], number][] = [
    ['ROOMMATE', [['2A', 'BOOM'], ['6A', 'RANG']], 'RMMT', 'B1', ['ROOMMATE'], 147],
    ['BOOMERANG', [['E1', 'BOOM'], ['E6', 'RANG'], ['5A', 'BOO'], ['5F', 'RANG']], 'M', '5A', ['BOOMERANG'], 261],
    ['BOOMERANGS', [['1F', 'RANG']], 'BMS', '1A', ['BOOMERANGS'], 186],
    ['SOS', [['A1', 'BOOM'], ['C1', 'RANG']], 'SS', '5A', ['SOS', 'BOOMS', 'RANGS'], 42],
    ['ANOPIAS', [['F1', 'FLOPPY'], ['3A', 'SCHIZOGNATHOUS'], ['5B', 'ZYGAPOPHYSEAL']], 'NS', '4C', ['ANOPIAS', 'HAY', 'ING', 'ZOA', 'GIO', 'NAP', 'ASH'], 171],
  ];
  for (const [word, existing, rack, notation, words, score] of examples) it(`generates and scores ${word} at ${score}`, () => {
    const position = fixture(existing, rack), moves = new Map<string, number>();
    findBestMove(position, dictionary(words), { onMove: (move, value) => moves.set(key(move), value) });
    expect(moves.get(key(action(notation, word)))).toBe(score);
    compare(position, words);
  });
  it('matches exhaustive engine oracle across random boards, inventories, histories and boundaries', () => {
    const words = ['CAT', 'CATS', 'ACT', 'ACTS', 'TAC', 'RAT', 'RATS', 'ART', 'TAR', 'CART', 'CARTS', 'STAR', 'START', 'SAT', 'SAY', 'STY', 'TRY', 'CRY', 'CAR', 'CARS', 'SCAR', 'SCARY', 'AAA', 'AEI', 'PST', 'AT'];
    fc.assert(fc.property(fc.integer({ min: 0, max: 14 }), fc.integer({ min: 0, max: 12 }), fc.array(fc.constantFrom<Letter>('C', 'T', 'S', 'R'), { minLength: 0, maxLength: 6 }), fc.boolean(), (row, column, rack, repeat) => {
      const position = fixture([[`${row + 1}${String.fromCharCode(65 + column)}`, 'CAT']], rack.join(''), repeat ? ['CAT', 'CATS', 'STAR'] : ['CAT']);
      position.vowels = { A: 2, E: 0, I: 0, O: 0, U: 0, Y: 1 };
      compare(position, words);
    }), { numRuns: 50, seed: 1729 });
  });
  it('allows all-vowel new tiles, all-consonant new tiles and Y as the sole vowel', () => {
    compare(fixture([['8H', 'R']], ''), ['AREA', 'ARIA', 'RYA', 'YOU']);
    compare(fixture([['8H', 'A']], 'CTS'), ['CAT', 'ACT', 'CAST', 'CATS', 'AT']);
    compare(fixture([['8H', 'Y']], 'STR'), ['STY', 'TRY', 'TRYST', 'PST', 'YYY']);
  });
  it('restricts secondary words as well as principals to the selected vocabulary', () => {
    const position = fixture([['A1', 'BOOM'], ['C1', 'RANG']], 'SS');
    const target = key(action('5A', 'SOS'));
    const moves = new Set<string>();
    findBestMove(position, dictionary(['SOS', 'BOOMS']), { onMove: move => moves.add(key(move)) });
    expect(moves.has(target)).toBe(false);
  });
  it('marks interrupted search incomplete and never mutates its input', () => {
    const position = fixture([['8F', 'CAT']], 'STRC');
    const before = JSON.stringify(position);
    const result = findBestMove(position, dictionary(['CATS', 'STAR', 'CART', 'CARTS']), { shouldCancel: () => true });
    expect(result.complete).toBe(false); expect(result.stats.candidates).toBe(0);
    expect(JSON.stringify(position)).toBe(before);
  });
});

describe('prebuilt tier artifacts', () => {
  it.each(['easy', 'medium'])('%s exactly preserves its intersected source words', level => {
    const graph = Gaddag.load(readFileSync(new URL(`../../../data/${level}.gaddag`, import.meta.url)), { decodeSeeds: false });
    const words = readFileSync(new URL(`../../../data/ai/${level}.txt`, import.meta.url), 'utf8').trimEnd().split('\n');
    expect(graph.wordCount).toBe(words.length); expect(graph.seedWords).toEqual([]);
    for (const word of words) expect(graph.has(word), word).toBe(true);
    for (const word of ['YOU', 'EYE']) expect(graph.has(word)).toBe(false);
  });
});
