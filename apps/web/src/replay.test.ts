import { describe, expect, it } from 'vitest';
import type { PublicGame } from '@bestword/contracts';
import { replayBoard,replayScores,replayTileOrigins } from './replay';
describe('public replay',()=>{
  it('reconstructs opening tiles and scores through word/skip/pass turns without private state',()=>{
    const board=Array(225).fill(null); board[0]='C';board[1]='A';board[2]='R';board[3]='E';board[4]='S';
    const game={board,moves:[{seat:0,score:30,tiles:[{row:0,column:1,letter:'A'},{row:0,column:2,letter:'R'}]},{seat:1,score:0,tiles:[]},{seat:0,score:42,tiles:[{row:0,column:3,letter:'E'},{row:0,column:4,letter:'S'}]},{seat:1,score:0,tiles:[]}]} as unknown as PublicGame;
    expect(replayBoard(game,0).slice(0,5)).toEqual(['C',null,null,null,null]);
    expect(replayBoard(game,1).slice(0,5)).toEqual(['C','A','R',null,null]);
    expect(replayBoard(game,2)).toEqual(replayBoard(game,1));
    expect(replayBoard(game,4)).toEqual(game.board); expect(replayScores(game,4)).toEqual([72,0]);
    expect(replayScores(game,0)).toEqual([0,0]); expect(game.board).toEqual(board);
  });
  it('retains opening and original player ownership through crossings, skips, reload and replay',()=>{
    const board=Array(225).fill(null);board[112]='A';board[111]='C';board[113]='T';board[96]='A';board[126]='E';
    // Seat 0 makes CAT through the opening A. Seat 1 then makes ACE through seat 0's C.
    const game={board,moves:[
      {seat:0,score:22,tiles:[{row:7,column:6,letter:'C'},{row:7,column:8,letter:'T'}]},
      {seat:1,score:0,tiles:[]},
      {seat:1,score:20,tiles:[{row:6,column:6,letter:'A'},{row:8,column:6,letter:'E'}]},
      {seat:0,score:0,tiles:[]}
    ]} as unknown as PublicGame;
    const seed=replayTileOrigins(game,0);expect(seed[112]).toBe('opening');expect(seed[111]).toBeNull();
    const first=replayTileOrigins(game,1);expect(first[111]).toBe(0);expect(first[113]).toBe(0);expect(first[96]).toBeNull();
    expect(replayTileOrigins(game,2)).toEqual(first);
    const final=replayTileOrigins(game,game.moves.length);expect(final[112]).toBe('opening');expect(final[111]).toBe(0);expect(final[96]).toBe(1);expect(final[126]).toBe(1);expect(final[0]).toBeNull();
    expect(replayTileOrigins(JSON.parse(JSON.stringify(game)) as PublicGame,4)).toEqual(final);
    expect(replayTileOrigins(game,0)).toEqual(seed);expect(game.board).toEqual(board);
  });
});
