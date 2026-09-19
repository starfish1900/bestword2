import { LETTERS, VOWELS, isVowel, type Board, type Direction, type Letter, type PlaceWordAction, type Vowel } from '@bestword/contracts';
import { calculateWordScore, LETTER_VALUES } from '@bestword/engine';
import type { Gaddag } from '@bestword/lexicon';

export interface AiPosition {
  board: readonly (Letter | null)[];
  rack: readonly Letter[];
  vowels: Readonly<Record<Vowel, number>>;
  principalHistory: readonly string[];
}
export type SearchLexicon = Pick<Gaddag, 'root' | 'next' | 'isTerminal' | 'has' | 'transitionMask'>;
export interface SearchStats { visited: number; candidates: number; elapsedMs: number }
export interface SearchOptions {
  shouldCancel?: () => boolean;
  /** Testing/diagnostics only: production streams candidates without retaining them. */
  onMove?: (action: PlaceWordAction, score: number) => void;
}
export interface SearchResult { complete: boolean; move: PlaceWordAction | null; score: number; stats: SearchStats }
const ALL_LETTERS = 0x07ff_fffe;
const VALUES = LETTERS.map(letter => LETTER_VALUES[letter]);
const CONSONANTS = LETTERS.map(letter => isVowel(letter) ? 0 : 1);
const VOWEL_MASK = VOWELS.reduce((mask, letter) => mask | (1 << (letter.charCodeAt(0) - 64)), 0);
function composition(word: string): boolean {
  let mask = 0;
  for (let i = 0; i < word.length; i++) mask |= 1 << (word.charCodeAt(i) - 64);
  return (mask & VOWEL_MASK) !== 0 && (mask & ~VOWEL_MASK) !== 0;
}
function before(a: PlaceWordAction, b: PlaceWordAction): boolean {
  return a.word < b.word || (a.word === b.word && (a.direction < b.direction || (a.direction === b.direction && (a.row < b.row || (a.row === b.row && a.column < b.column)))));
}

/** Exhaustive anchor/GADDAG search. Live memory is independent of generated-move count. */
export function findBestMove(position: AiPosition, lexicon: SearchLexicon, options: SearchOptions = {}): SearchResult {
  const started = performance.now();
  if (position.board.length !== 225) throw new Error('AI board must contain 225 cells');
  const board = position.board;
  const available = new Uint8Array(26);
  for (const letter of position.rack) {
    if (isVowel(letter)) throw new Error('AI rack must contain consonants only');
    available[letter.charCodeAt(0) - 65]!++;
  }
  for (const letter of VOWELS) {
    const quantity = position.vowels[letter];
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 24) throw new Error('Invalid AI vowel inventory');
    available[letter.charCodeAt(0) - 65] = quantity;
  }
  let availableMask = 0;
  for (let i = 0; i < 26; i++) if (available[i]) availableMask |= 1 << (i + 1);
  const history = new Set(position.principalHistory);
  const anchors = new Uint8Array(225);
  const crossMasks = new Int32Array(450);
  const crossScores = new Int32Array(450 * 26);
  const at = (r: number, c: number): Letter | null => r < 0 || c < 0 || r > 14 || c > 14 ? null : board[r * 15 + c] ?? null;
  let cancelled = false;
  const stats: SearchStats = { visited: 0, candidates: 0, elapsedMs: 0 };
  const checkCancel = (): boolean => {
    if (!cancelled && options.shouldCancel?.()) cancelled = true;
    return cancelled;
  };
  let best: PlaceWordAction | null = null;
  let bestScore = 0;
  for (let index = 0; index < 225 && !checkCancel(); index++) {
    if (board[index]) continue;
    const row = Math.floor(index / 15), column = index % 15;
    anchors[index] = Number(Boolean(at(row - 1, column) || at(row + 1, column) || at(row, column - 1) || at(row, column + 1)));
    for (let orientation = 0; orientation < 2; orientation++) {
      const dr = orientation === 0 ? 1 : 0, dc = 1 - dr;
      let prefix = '', suffix = '';
      for (let r = row - dr, c = column - dc; at(r, c); r -= dr, c -= dc) prefix = at(r, c)! + prefix;
      for (let r = row + dr, c = column + dc; at(r, c); r += dr, c += dc) suffix += at(r, c)!;
      const table = orientation * 225 + index;
      if (!prefix && !suffix) { crossMasks[table] = ALL_LETTERS; continue; }
      if (prefix.length + suffix.length + 1 < 3) continue;
      let oldSum = 0;
      for (const letter of prefix + suffix) oldSum += LETTER_VALUES[letter as Letter];
      for (let letter = 0; letter < 26; letter++) {
        const word = prefix + LETTERS[letter]! + suffix;
        if (!composition(word) || !lexicon.has(word)) continue;
        crossMasks[table]! |= 1 << (letter + 1);
        crossScores[table * 26 + letter] = calculateWordScore(oldSum + VALUES[letter]!, 0, prefix && suffix ? 1 : 0, false);
      }
    }
  }
  const letters = new Array<Letter>(15);
  for (let orientation = 0; orientation < 2 && !cancelled; orientation++) {
    const direction: Direction = orientation === 0 ? 'H' : 'V';
    for (let anchor = 0; anchor < 225 && !checkCancel(); anchor++) {
      if (!anchors[anchor]) continue;
      const row = Math.floor(anchor / 15), column = anchor % 15;
      const axis = orientation === 0 ? column : row;
      const indexAt = (pos: number): number => orientation === 0 ? row * 15 + pos : pos * 15 + column;
      const occupied = (pos: number): boolean => pos >= 0 && pos < 15 && Boolean(board[indexAt(pos)]);
      function emit(start: number, end: number, node: number, placed: number, olds: number, firstOld: number, lastOld: number, sum: number, consonants: number, secondary: number): void {
        if (placed < 2 || end - start + 1 < 3 || consonants === 0 || consonants === end - start + 1 || !lexicon.isTerminal(node)) return;
        let word = '';
        for (let pos = start; pos <= end; pos++) word += letters[pos]!;
        if (history.has(word)) return;
        const score = calculateWordScore(sum, consonants, olds < 2 ? 0 : lastOld - firstOld + 1 - olds, true) + secondary;
        const action: PlaceWordAction = { type: 'PLACE_WORD', row: orientation === 0 ? row : start, column: orientation === 0 ? start : column, direction, word };
        stats.candidates++;
        options.onMove?.(action, score);
        if (best === null || score > bestScore || (score === bestScore && before(action, best))) { best = action; bestScore = score; }
      }
      function walk(pos: number, node: number, reverse: boolean, start: number, placed: number, olds: number, firstOld: number, lastOld: number, sum: number, consonants: number, secondary: number): void {
        if (cancelled || pos < 0 || pos > 14) return;
        if ((++stats.visited & 255) === 0 && checkCancel()) return;
        const index = indexAt(pos), fixed = board[index];
        // Each complete move belongs only to its earliest newly covered anchor.
        if (reverse && pos < axis && !fixed && anchors[index]) return;
        const table = orientation * 225 + index;
        let mask = lexicon.transitionMask(node) & (fixed ? 1 << (fixed.charCodeAt(0) - 64) : availableMask & crossMasks[table]!);
        while (mask && !cancelled) {
          const bit = mask & -mask; mask ^= bit;
          const code = 31 - Math.clz32(bit), letterIndex = code - 1, letter = LETTERS[letterIndex]!;
          const next = lexicon.next(node, letter)!;
          letters[pos] = letter;
          const oldCount = olds + Number(Boolean(fixed));
          const minOld = fixed ? Math.min(firstOld, pos) : firstOld;
          const maxOld = fixed ? Math.max(lastOld, pos) : lastOld;
          const newCount = placed + Number(!fixed);
          const valueSum = sum + VALUES[letterIndex]!;
          const cons = consonants + CONSONANTS[letterIndex]!;
          const crosses = secondary + (fixed ? 0 : crossScores[table * 26 + letterIndex]!);
          if (!fixed && --available[letterIndex]! === 0) availableMask &= ~bit;
          if (reverse) {
            if (!occupied(pos - 1)) {
              if (!occupied(axis + 1)) emit(pos, axis, next, newCount, oldCount, minOld, maxOld, valueSum, cons, crosses);
              const separator = lexicon.next(next, '+');
              if (separator !== null) walk(axis + 1, separator, false, pos, newCount, oldCount, minOld, maxOld, valueSum, cons, crosses);
            }
            walk(pos - 1, next, true, pos, newCount, oldCount, minOld, maxOld, valueSum, cons, crosses);
          } else {
            if (!occupied(pos + 1)) emit(start, pos, next, newCount, oldCount, minOld, maxOld, valueSum, cons, crosses);
            walk(pos + 1, next, false, start, newCount, oldCount, minOld, maxOld, valueSum, cons, crosses);
          }
          if (!fixed) { available[letterIndex]!++; availableMask |= bit; }
        }
      }
      walk(axis, lexicon.root, true, axis, 0, 0, 15, -1, 0, 0, 0);
    }
  }
  stats.elapsedMs = performance.now() - started;
  return { complete: !cancelled, move: best, score: bestScore, stats };
}

/** Apply a searched placement to the public/own-information projection only. */
export function applyPlacement(position: AiPosition, action: PlaceWordAction): AiPosition {
  const board: Board = [...position.board], rack = [...position.rack], vowels = { ...position.vowels };
  for (let offset = 0; offset < action.word.length; offset++) {
    const index = (action.row + (action.direction === 'V' ? offset : 0)) * 15 + action.column + (action.direction === 'H' ? offset : 0);
    if (board[index]) continue;
    const letter = action.word[offset] as Letter;
    board[index] = letter;
    if (isVowel(letter)) vowels[letter]--; else rack.splice(rack.indexOf(letter), 1);
  }
  return { board, rack, vowels, principalHistory: [...position.principalHistory, action.word] };
}
