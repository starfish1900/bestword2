import type { Board, PublicGame } from '@bestword/contracts';
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
