import type { Board, PublicGame, Seat } from '@bestword/contracts';
export type TileOrigin = 'opening' | Seat | null;
/** Accepted tiles uniquely identify what was absent on the seed board. */
export function replayBoard(game: PublicGame, moveCount: number): Board {
  const board = [...game.board];
  for (const move of game.moves) for (const tile of move.tiles) board[tile.row * 15 + tile.column] = null;
  for (const move of game.moves.slice(0, moveCount)) for (const tile of move.tiles) board[tile.row * 15 + tile.column] = tile.letter;
  return board;
}
export function replayScores(game: PublicGame, moveCount: number): [number, number] {
  const scores: [number,number] = [0,0];
  for (const move of game.moves.slice(0, moveCount)) scores[move.seat] += move.score;
  return scores;
}
/** Ownership belongs to the original contributor, even when later words cross it. */
export function replayTileOrigins(game: PublicGame, moveCount: number): TileOrigin[] {
  const origins: TileOrigin[] = game.board.map(letter => letter ? 'opening' : null);
  for (const move of game.moves) for (const tile of move.tiles) origins[tile.row * 15 + tile.column] = null;
  for (const move of game.moves.slice(0, moveCount)) for (const tile of move.tiles) origins[tile.row * 15 + tile.column] = move.seat;
  return origins;
}
