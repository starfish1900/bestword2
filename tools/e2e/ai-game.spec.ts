import { test, expect } from '@playwright/test';
import type { GameView } from '@bestword/contracts';
import { account } from './helpers';

test('a real computer game starts, commits an AI word and remains replayable',async({browser,baseURL},testInfo)=>{
  test.skip(process.env.BESTWORD_AI_E2E!=='1','Requires a running compatible AI worker.');
  test.setTimeout(150000);
  const name=`BA${process.env.BESTWORD_E2E_RUN_ID}`.slice(0,15),player=await account(browser,baseURL!,name);
  try{
    await player.page.getByRole('button',{name:'Computer',exact:true}).click();await player.page.getByRole('button',{name:'Easy',exact:true}).click();
    const created=player.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/games/ai'&&response.request().method()==='POST');
    await player.page.getByRole('button',{name:'Play against AI',exact:true}).click();expect((await created).status()).toBe(201);await expect(player.page).toHaveURL(/\/game\/[\da-f-]+$/);
    const gameId=new URL(player.page.url()).pathname.split('/').at(-1)!;
    const read=async():Promise<GameView>=>{const response=await player.context.request.get(`/api/games/${gameId}`);expect(response.ok()).toBe(true);return response.json();};
    await expect.poll(async()=>{const view=await read();return view.game.status==='active'&&(view.game.startsAt===null||view.game.startsAt<=view.game.serverTime);},{timeout:20000}).toBe(true);
    await expect(player.page.locator('.ai-level')).toHaveText('Easy AI ·');
    // Permanently pass on the first human turn so the real worker can proceed
    // regardless of which randomly chosen seat started the game.
    await expect(player.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible({timeout:45000});await player.page.getByRole('button',{name:'Pass forever',exact:true}).click();await player.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}).click();
    await expect.poll(async()=>(await read()).game.moves.some(move=>move.seat===1&&move.action==='PLACE_WORD'),{timeout:90000}).toBe(true);
    const view=await read(),index=view.game.moves.findIndex(move=>move.seat===1&&move.action==='PLACE_WORD'),move=view.game.moves[index]!;expect(view.game.ai).toEqual({seat:1,difficulty:'easy'});expect(move.score).toBeGreaterThan(0);expect(move.tiles.length).toBeGreaterThanOrEqual(2);
    await player.page.goto(`/game/${gameId}?replay=1&move=${index+1}`);await expect(player.page.getByRole('slider',{name:'Replay move'})).toHaveValue(String(index+1));await expect(player.page.locator('.replay-controls h2')).toHaveText(move.word!);await expect(player.page.locator('.square.player-1')).toHaveCount(move.tiles.length);
    await player.page.getByRole('button',{name:'Move history',exact:true}).click();await expect(player.page.locator('.full-history')).toContainText(move.word!);await player.page.getByRole('button',{name:'Close dialog',exact:true}).click();await player.page.screenshot({path:testInfo.outputPath('real-ai-replay.png')});
    await testInfo.attach('real-ai-game.json',{body:JSON.stringify({gameId,difficulty:view.game.ai?.difficulty,firstAiWord:move.word,score:move.score,position:index+1,revision:view.game.revision},null,2),contentType:'application/json'});
  }finally{await player.context.close();}
});
