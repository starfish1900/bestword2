import { BOARD_SIZE, isVowel, type Board, type Direction, type Letter, type PlaceWordAction, type PlacedTile, type Vowel } from '@bestword/contracts';

export interface Draft { direction: Direction; cursor: number | null; tiles: PlacedTile[]; clicks: number }
export const emptyDraft = (): Draft => ({ direction: 'H', cursor: null, tiles: [], clicks: 0 });
export const tileIndex = (tile: PlacedTile) => tile.row * BOARD_SIZE + tile.column;
function next(index: number, direction: Direction, delta = 1): number | null {
  const row = Math.floor(index / BOARD_SIZE) + (direction === 'V' ? delta : 0);
  const col = index % BOARD_SIZE + (direction === 'H' ? delta : 0);
  return row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE ? null : row * BOARD_SIZE + col;
}
export function clickSquare(draft: Draft, board: Board, index: number): Draft {
  if (index < 0 || index >= BOARD_SIZE ** 2) return draft;
  if (board[index]) return { ...draft, tiles: [] };
  return { direction: draft.clicks % 2 === 0 ? 'H' : 'V', cursor: index, tiles: [], clicks: draft.clicks + 1 };
}
export function reserved(draft: Draft, letter: Letter): number { return draft.tiles.filter(tile => tile.letter === letter).length; }
export function availableCount(draft: Draft, letter: Letter, rack: Letter[], vowels: Record<Vowel, number>): number {
  return (isVowel(letter) ? vowels[letter] : rack.filter(item => item === letter).length) - reserved(draft, letter);
}
export function typeLetter(draft: Draft, board: Board, letter: Letter, rack: Letter[], vowels: Record<Vowel, number>): { draft: Draft; error: string | null } {
  if (draft.cursor === null) return { draft, error: draft.tiles.length ? 'You have reached the board edge.' : 'Choose an empty square first.' };
  if (board[draft.cursor]) return { draft, error: 'Choose an empty square.' };
  if (availableCount(draft, letter, rack, vowels) <= 0) return { draft, error: isVowel(letter) ? `No ${letter} vowels remain.` : `No ${letter} remains on your rack.` };
  const tile: PlacedTile = { row: Math.floor(draft.cursor / BOARD_SIZE), column: draft.cursor % BOARD_SIZE, letter };
  let cursor = next(draft.cursor, draft.direction);
  while (cursor !== null && board[cursor]) cursor = next(cursor, draft.direction);
  return { draft: { ...draft, tiles: [...draft.tiles, tile], cursor }, error: null };
}
export function eraseLetter(draft: Draft): Draft {
  const tile = draft.tiles.at(-1);
  return tile ? { ...draft, cursor: tileIndex(tile), tiles: draft.tiles.slice(0, -1) } : draft;
}
export function clearDraft(draft: Draft): Draft {
  return { ...draft, tiles: [], cursor: draft.tiles[0] ? tileIndex(draft.tiles[0]) : draft.cursor };
}
/** Infer the complete maximal word, including old prefix, crossings and suffix. */
export function inferMove(draft: Draft, board: Board): PlaceWordAction | null {
  const first = draft.tiles[0];
  if (!first) return null;
  const projected = [...board];
  for (const tile of draft.tiles) projected[tileIndex(tile)] = tile.letter;
  let start = tileIndex(first);
  let prior = next(start, draft.direction, -1);
  while (prior !== null && projected[prior]) { start = prior; prior = next(start, draft.direction, -1); }
  let word = '';
  let index: number | null = start;
  while (index !== null && projected[index]) { word += projected[index]; index = next(index, draft.direction); }
  return { type: 'PLACE_WORD', row: Math.floor(start / BOARD_SIZE), column: start % BOARD_SIZE, direction: draft.direction, word };
}
