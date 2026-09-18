import { describe, expect, it } from 'vitest';
import type { PublicGame } from '@bestword/contracts';
import { replayBoard,replayScores } from './replay';
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
});
