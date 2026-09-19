import { test, expect, type Page } from '@playwright/test';
import type { GameView } from '@bestword/contracts';
import { account, findLegalPlacement } from './helpers';

const clockSeconds=async(page:Page)=>{
  const text=await page.locator('.player-card.active time').innerText();
  const [minutes,seconds]=text.split(':').map(Number);
  return minutes!*60+seconds!;
};

// Browser-only clock injection: the real server, performance.now and timers are unchanged.
test('one-hour page wall-clock jump preserves the turn and draft through real periodic sync',async({browser,baseURL},testInfo)=>{
  const origin=baseURL!,prefix=`BW${process.env.BESTWORD_E2E_RUN_ID}`.slice(0,13);
  const unchangedReplies=new Map<Page,number>();
  const observe=(page:Page)=>page.on('websocket',socket=>socket.on('framereceived',frame=>{
    if(String(frame.payload).includes('"unchanged":true'))unchangedReplies.set(page,(unchangedReplies.get(page)??0)+1);
  }));
  const alice=await account(browser,origin,`${prefix}A`,observe);
  const bob=await account(browser,origin,`${prefix}B`,observe);
  const errors:string[]=[];for(const player of [alice,bob])player.page.on('pageerror',error=>errors.push(error.message));
  try{
    await alice.page.getByRole('button',{name:'Create a game',exact:true}).click();
    await expect(alice.page.locator('.your-seek')).toBeVisible();
    await bob.page.locator('.seek-row').filter({hasText:`${prefix}A`}).getByRole('button',{name:'Join',exact:true}).click();
    await expect(bob.page).toHaveURL(/\/game\/[\da-f-]+$/);await expect(alice.page).toHaveURL(bob.page.url());
    const gameId=bob.page.url().split('/').at(-1)!;
    const read=async(player=alice):Promise<GameView>=>{const response=await player.context.request.get(`/api/games/${gameId}`);expect(response.ok()).toBe(true);return response.json() as Promise<GameView>;};
    await expect.poll(async()=>{const view=await read();return view.game.status==='active'&&view.game.startsAt===null;}).toBe(true);
    const initial=await read(),actor=initial.you?.seat===initial.game.activeSeat?alice:bob,other=actor===alice?bob:alice;
    await expect(actor.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();
    const before=await read(actor),placement=await findLegalPlacement(before),first=placement.tiles[0]!;
    const target=actor.page.locator(`#square-${first.row*15+first.column}`);await target.click();
    const direction=placement.action.direction==='H'?'horizontal cursor':'vertical cursor';
    if(!(await target.getAttribute('aria-label'))?.includes(direction))await target.click();
    await expect(target).toHaveAttribute('aria-label',new RegExp(direction));
    await actor.page.keyboard.type(placement.tiles.map(tile=>tile.letter).join(''));
    const draftLabels=await actor.page.locator('.draft-tile').evaluateAll(tiles=>tiles.map(tile=>tile.getAttribute('aria-label')));
    expect(draftLabels).toHaveLength(placement.tiles.length);
    await expect(actor.page.getByRole('button',{name:'Play word',exact:true})).toBeEnabled();
    const clockBefore=await clockSeconds(actor.page),started=performance.now();
    const injection=await actor.page.evaluate(()=>{
      const originalNow=Date.now;
      (window as unknown as {restoreDateNow:()=>void}).restoreDateNow=()=>{Date.now=originalNow;};
      Date.now=()=>originalNow()+60*60*1000;
      // Bracket the shifted read with native reads: task scheduling can delay any
      // pair of calls, so their raw difference need not be exactly one hour.
      const nativeBefore=originalNow(),shiftedNow=Date.now(),nativeAfter=originalNow();
      return {nativeBefore,shiftedNow,nativeAfter,wallClockShiftMs:shiftedNow-nativeBefore,performanceAtInjection:performance.now()};
    });
    expect(injection.shiftedNow).toBeGreaterThanOrEqual(injection.nativeBefore+60*60*1000);
    expect(injection.shiftedNow).toBeLessThanOrEqual(injection.nativeAfter+60*60*1000);
    // Two display ticks expose the former expiry/input bug before the next sync can repair it.
    await expect.poll(()=>actor.page.evaluate(start=>performance.now()-start,injection.performanceAtInjection),{intervals:[100,100,100]}).toBeGreaterThanOrEqual(450);
    const clockAfterJump=await clockSeconds(actor.page);
    expect(Math.abs(clockAfterJump-clockBefore)).toBeLessThanOrEqual(2);
    await expect(actor.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();
    await expect(actor.page.getByRole('button',{name:'Play word',exact:true})).toBeEnabled();
    await expect(actor.page.getByRole('button',{name:'No words',exact:true})).toBeEnabled();
    const baseline=unchangedReplies.get(actor.page)??0;
    await expect.poll(()=>unchangedReplies.get(actor.page)??0,{timeout:16000}).toBeGreaterThan(baseline);
    const afterSync=await read(actor),clockAfterSync=await clockSeconds(actor.page),elapsedSeconds=(performance.now()-started)/1000;
    expect(afterSync.game.revision).toBe(before.game.revision);expect(afterSync.game.moves).toHaveLength(0);
    expect(Math.abs(clockAfterSync-(clockBefore-elapsedSeconds))).toBeLessThanOrEqual(2);
    expect(Math.abs(clockAfterSync-Math.ceil(afterSync.game.clocksMs[afterSync.game.activeSeat]/1000))).toBeLessThanOrEqual(2);
    expect(await actor.page.locator('.draft-tile').evaluateAll(tiles=>tiles.map(tile=>tile.getAttribute('aria-label')))).toEqual(draftLabels);
    await expect(actor.page.getByRole('button',{name:'Play word',exact:true})).toBeEnabled();
    await actor.page.screenshot({path:testInfo.outputPath('clock-injection-draft.png')});
    await actor.page.getByRole('button',{name:'Play word',exact:true}).click();
    await expect.poll(async()=>(await read(actor)).game.moves.length).toBe(1);
    expect((await read(actor)).game.moves[0]!.tiles).toEqual(placement.tiles);
    await actor.page.evaluate(()=>(window as unknown as {restoreDateNow:()=>void}).restoreDateNow());
    for(const player of [other,actor]){
      await expect(player.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();
      await player.page.getByRole('button',{name:'Pass forever',exact:true}).click();
      await player.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}).click();
    }
    await expect.poll(async()=>(await read()).game.status).toBe('finished');expect(errors).toEqual([]);
    await testInfo.attach('browser-clock-injection',{body:JSON.stringify({scope:'Only page Date.now shifted; real server and performance.now unchanged',gameId,...injection,clockBefore,clockAfterJump,clockAfterSync,elapsedSeconds,revisionBefore:before.game.revision,revisionAfterSync:afterSync.game.revision,unchangedReplies:(unchangedReplies.get(actor.page)??0)-baseline,draftTilesPreserved:placement.tiles.length,acceptedWord:placement.action.word},null,2),contentType:'application/json'});
  }finally{await alice.context.close();await bob.context.close();}
});
