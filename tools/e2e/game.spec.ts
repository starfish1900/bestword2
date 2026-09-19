import { test, expect, type Page } from '@playwright/test';
import type { GameView } from '@bestword/contracts';
import { account, enterPlacement, findLegalPlacement } from './helpers';

async function expectContainedBoard(page:Page){
  const rectangles=await page.evaluate(()=>{
    const frame=document.querySelector('.board-frame')!.getBoundingClientRect();
    const board=document.querySelector('.board-grid')!.getBoundingClientRect();
    const square=document.querySelector('.square')!.getBoundingClientRect();
    const footnote=document.querySelector('.board-footnote')!.getBoundingClientRect();
    return {frame:frame.toJSON(),board:board.toJSON(),square:square.toJSON(),footnote:footnote.toJSON()};
  });
  expect(rectangles.board.bottom).toBeLessThanOrEqual(rectangles.frame.bottom);
  expect(rectangles.board.right).toBeLessThanOrEqual(rectangles.frame.right);
  expect(rectangles.board.bottom).toBeLessThanOrEqual(rectangles.footnote.top);
  expect(Math.abs(rectangles.square.width-rectangles.square.height)).toBeLessThanOrEqual(1);
}

test('two real players match, place a word, skip, pass, spectate and replay',async({browser,baseURL},testInfo)=>{
  const origin=baseURL!;const prefix=`BW${process.env.BESTWORD_E2E_RUN_ID}`.slice(0,13);const aliceName=`${prefix}A`,bobName=`${prefix}B`;
  const unchangedReplies=new Map<Page,number>();const revisionRequests=new Map<Page,number>();
  const observe=(page:Page)=>page.on('websocket',socket=>{
    socket.on('framereceived',frame=>{if(String(frame.payload).includes('"unchanged":true'))unchangedReplies.set(page,(unchangedReplies.get(page)??0)+1);});
    socket.on('framesent',frame=>{const payload=String(frame.payload);if(payload.includes('"game:sync"')&&/"revision":\d+/.test(payload))revisionRequests.set(page,(revisionRequests.get(page)??0)+1);});
  });
  const alice=await account(browser,origin,aliceName,observe);const bob=await account(browser,origin,bobName,observe);
  const spectator=await browser.newContext({baseURL:origin,viewport:{width:390,height:844}});const watch=await spectator.newPage();
  const errors:string[]=[];for(const page of [alice.page,bob.page,watch])page.on('pageerror',error=>errors.push(error.message));
  try{
    await alice.page.getByRole('button',{name:'Create a game',exact:true}).click();await expect(alice.page.locator('.your-seek')).toContainText('15 minute table is open');
    await bob.page.locator('.seek-row').filter({hasText:aliceName}).getByRole('button',{name:'Join',exact:true}).click();
    await expect(bob.page).toHaveURL(/\/game\/[\da-f-]+$/);await expect(alice.page).toHaveURL(bob.page.url());
    const gameId=bob.page.url().split('/').at(-1)!;const read=async(which=alice):Promise<GameView>=>{const response=await which.context.request.get(`/api/games/${gameId}`);expect(response.ok()).toBe(true);return response.json() as Promise<GameView>;};
    await expect.poll(async()=>{const view=await read();return view.game.status==='active'&&(view.game.startsAt===null||view.game.serverTime>=view.game.startsAt);}).toBe(true);
    let initial=await read();const actor=initial.you?.seat===initial.game.activeSeat?alice:bob;const other=actor===alice?bob:alice;
    await expect(actor.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();await expect(actor.page.locator('[role=gridcell]')).toHaveCount(225);
    for(const [label,width,height] of [['desktop',1280,800],['portrait',390,844],['small-phone',320,568],['landscape',568,320]] as const){await actor.page.setViewportSize({width,height});await expectContainedBoard(actor.page);const size=await actor.page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,bottom:document.querySelector('.alternative-actions')!.getBoundingClientRect().bottom}));expect(size.scrollWidth).toBeLessThanOrEqual(width);expect(size.scrollHeight).toBeLessThanOrEqual(height);expect(size.bottom).toBeLessThanOrEqual(height);await actor.page.screenshot({path:testInfo.outputPath(`${label}-active.png`)});}await actor.page.setViewportSize({width:1280,height:800});
    await watch.goto(`/game/${gameId}`);await expect(watch.locator('.game-format')).toContainText('Spectating');await expect(watch.locator('.rack-tile')).toHaveCount(0);
    const spectatorResponse=await spectator.request.get(`/api/games/${gameId}`);const publicView=await spectatorResponse.json() as GameView;expect(publicView.you).toBeNull();expect(JSON.stringify(publicView)).not.toContain('password_hash');
    initial=await read(actor);const initialBoard=[...initial.game.board];
    // A deliberately isolated, two-letter principal is rejected while keeping its draft.
    const empty=initial.game.board.findIndex((cell,index)=>!cell&&index%15<13&&!initial.game.board[index+1]&&!initial.game.board[index+2]&&(index%15===0||!initial.game.board[index-1]));expect(empty).toBeGreaterThanOrEqual(0);
    await actor.page.locator(`#square-${empty}`).click();await actor.page.keyboard.type('AE');await actor.page.screenshot({path:testInfo.outputPath('draft-input.png')});await actor.page.getByRole('button',{name:'Play word',exact:true}).click();
    await expect(actor.page.locator('.game-message')).toContainText(/not valid|at least|connect|dictionary|letters/i);await expect(actor.page.locator('.draft-tile')).toHaveCount(2);
    // Observe a real periodic revision-only sync while an invalid draft remains on the board.
    const baseline=unchangedReplies.get(actor.page)??0;
    await expect.poll(()=>unchangedReplies.get(actor.page)??0,{timeout:16000}).toBeGreaterThan(baseline);
    expect(revisionRequests.get(actor.page)).toBeGreaterThan(0);await expect(actor.page.locator('.draft-tile')).toHaveCount(2);
    expect((await read(actor)).game.moves).toHaveLength(0);await actor.page.keyboard.press('Backspace');await expect(actor.page.locator('.draft-tile')).toHaveCount(1);
    await actor.page.getByRole('button',{name:'Clear',exact:true}).click();
    const placement=await findLegalPlacement(await read(actor));await enterPlacement(actor.page,placement);
    await expect.poll(async()=>(await read(actor)).game.moves.length).toBe(1);await expect(actor.page.locator('.draft-tile')).toHaveCount(0);
    const afterWord=await read(actor);expect(afterWord.game.moves[0]?.word).toBe(placement.action.word);expect(afterWord.game.board).not.toEqual(initialBoard);
    await expect(watch.locator('.board-footnote')).toContainText(placement.action.word);
    await expect(other.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();await other.page.getByRole('button',{name:'No words',exact:true}).click();
    await expect.poll(async()=>(await read()).game.moves.at(-1)?.action).toBe('NO_WORDS');
    await expect(actor.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();await actor.page.getByRole('button',{name:'Pass forever',exact:true}).click();
    await expect(actor.page.getByRole('dialog')).toContainText('Passing is permanent');await actor.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}).click();
    await expect(other.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();await expect(other.page.getByRole('button',{name:'No words',exact:true})).toBeDisabled();
    await other.page.getByRole('button',{name:'Pass forever',exact:true}).click();await other.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}).click();
    await expect.poll(async()=>(await read()).game.status).toBe('finished');const final=await read();expect(final.game.moves).toHaveLength(4);expect(final.game.result?.reason).toBe('both-passed');
    await expect(watch.locator('.result-card')).toBeVisible();await expect(watch.getByRole('link',{name:'Sign in to replay',exact:true})).toBeVisible();await spectator.addCookies(await alice.context.cookies());await watch.reload();await watch.getByRole('button',{name:'Explore the replay',exact:true}).click();await expect(watch.getByRole('slider',{name:'Replay move'})).toHaveValue('0');
    await watch.getByRole('button',{name:'Next move',exact:true}).click();await expect(watch.getByRole('slider',{name:'Replay move'})).toHaveValue('1');await expect(watch.locator('.replay-controls h2')).toHaveText(placement.action.word);
    await watch.getByRole('button',{name:'Last position',exact:true}).click();await expect(watch.getByRole('slider',{name:'Replay move'})).toHaveValue('4');
    await watch.getByRole('button',{name:'Move history',exact:true}).click();await expect(watch.locator('.full-history>li')).toHaveCount(4);await expect(watch.locator('.score-breakdown')).toContainText(placement.action.word);await watch.getByRole('button',{name:'Close dialog'}).click();
    // One committed game is reused across viewport checks; this is a real server response.
    await actor.page.getByRole('button',{name:'Explore the replay',exact:true}).click();
    for(const [label,width,height] of [['desktop',1280,800],['portrait',390,844],['small-phone',320,568],['landscape',568,320]] as const){await actor.page.setViewportSize({width,height});await expectContainedBoard(actor.page);const size=await actor.page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));expect(size.scrollWidth).toBeLessThanOrEqual(width);expect(size.scrollHeight).toBeLessThanOrEqual(height);await actor.page.screenshot({path:testInfo.outputPath(`${label}.png`)});}
    expect(errors).toEqual([]);
  }finally{await alice.context.close();await bob.context.close();await spectator.close();}
});
