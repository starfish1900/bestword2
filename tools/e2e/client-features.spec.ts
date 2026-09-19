import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { AiDifficulty, GameSummary, GameView, PublicMove, TileOrigin } from '@bestword/contracts';

// Deliberate presentation/wire fixtures. Real authorization, persistence and AI
// move generation are covered by the server/integration suite, not these cases.
const gameId='15453d0c-0d68-4043-8336-9068cbd08aeb';
const user={id:'186879c9-e234-4ca7-9c74-03f1c9570132',username:'ClientFixture'};
const opponent={id:'cff74a2c-b1a5-4791-99ca-1cc80bdbcc48',username:'OtherFixture'};
function fixtureView(signedIn:boolean,active=false,difficulty?:AiDifficulty):GameView{
  const board:GameView['game']['board']=Array(225).fill(null),origins:TileOrigin[]=Array(225).fill(null);
  board[111]='C';origins[111]='opening';
  const moves:PublicMove[]=[
    {revision:2,seat:0,action:'PLACE_WORD',at:1000,score:22,word:'CAT',notation:'8G CAT',words:[],tiles:[{row:7,column:7,letter:'A'},{row:7,column:8,letter:'T'}]},
    {revision:3,seat:1,action:'PLACE_WORD',at:2000,score:26,word:'BAT',notation:'H7 BAT',words:[],tiles:[{row:6,column:7,letter:'B'},{row:8,column:7,letter:'T'}]},
  ];
  for(const move of moves)for(const tile of move.tiles){board[tile.row*15+tile.column]=tile.letter;origins[tile.row*15+tile.column]=move.seat;}
  const now=Date.now();
  return {game:{id:gameId,revision:3,rulesVersion:'bestword-1',lexiconVersion:'fixture',status:active?'active':'finished',board,players:[{...user,score:22,rackSize:2,passed:!active,connected:true},{...opponent,score:26,rackSize:2,passed:!active,connected:true}],activeSeat:difficulty?1:0,minutes:15,clocksMs:[120000,120000],turnStartedAt:active?now:null,turnDeadlineAt:active?now+120000:null,startsAt:null,serverTime:now,vowelsRemaining:{A:10,E:10,I:10,O:10,U:10,Y:10},consonantsRemaining:100,principalHistory:signedIn?['OPENINGWORD','SECONDWORD','CAT','BAT']:['OPENINGWORD','SECONDWORD'],moves:signedIn?moves:[],historyAccess:signedIn?'full':'recent',moveCount:2,tileOrigins:origins,lastMoveTiles:moves[1]!.tiles,recentMoves:moves.map(({revision,seat,action,score,word,at})=>({revision,seat,action,score,word,at})),disconnectDeadlines:[null,null],pause:null,result:active?null:{winner:1,reason:'both-passed',at:3000},spectatorCount:1,...(difficulty?{ai:{seat:1 as const,difficulty}}:{})},you:signedIn&&active?{seat:0,rack:['B','T'],drawnThisTurn:2,canNoWords:true}:null};
}
async function wire(page:Page,read:()=>GameView){
  const counts={connections:0,closed:0};
  await page.routeWebSocket('**/socket.io/**',socket=>{
    counts.connections++;socket.send('0'+JSON.stringify({sid:'client-fixture',upgrades:[],pingInterval:1000000,pingTimeout:1000000,maxPayload:1000000}));
    socket.onClose(()=>counts.closed++);
    socket.onMessage(data=>{
      const message=String(data);if(message==='40'){socket.send('40'+JSON.stringify({sid:'client-fixture'}));return;}
      const match=/^42(\d+)(\[.*)$/s.exec(message);if(!match)return;
      const [event]=JSON.parse(match[2]!);const reply=event==='lobby:subscribe'?{ok:true}:event==='game:subscribe'||event==='game:sync'?{ok:true,view:read()}:undefined;
      if(reply)socket.send(`43${match[1]}[${JSON.stringify(reply)}]`);
    });
  });return counts;
}
async function simpleApi(page:Page,state:{signedIn:boolean;active?:boolean;difficulty?:AiDifficulty},onAi?:(body:unknown)=>void){
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session')await route.fulfill({json:{user:state.signedIn?user:null,activeGameId:null}});
    else if(path==='/api/auth/login'||path==='/api/auth/register'){state.signedIn=true;await route.fulfill({json:{user,activeGameId:null}});}
    else if(path==='/api/games/ai'){const body=route.request().postDataJSON() as {difficulty:AiDifficulty};state.difficulty=body.difficulty;state.active=true;onAi?.(body);await route.fulfill({json:{gameId}});}
    else if(path===`/api/games/${gameId}`)await route.fulfill({json:fixtureView(state.signedIn,state.active,state.difficulty)});
    else if(['/api/seeks','/api/games/live','/api/games/history'].includes(path))await route.fulfill({json:{items:[],nextCursor:null}});
    else await route.continue();
  });
  return wire(page,()=>fixtureView(state.signedIn,state.active,state.difficulty));
}

test('guest board remains public and sign-in restores the requested replay position',async({page})=>{
  const state={signedIn:false};await simpleApi(page,state);
  await page.goto(`/game/${gameId}?replay=1&move=1`);
  await expect(page.locator('.board-grid')).toBeVisible();await expect(page.locator('.replay-controls')).toHaveCount(0);
  await expect(page.locator('.opening-tile')).toHaveCount(1);await expect(page.locator('.square.player-0')).toHaveCount(2);await expect(page.locator('.square.player-1')).toHaveCount(2);
  await page.getByRole('button',{name:'Move history',exact:true}).click();await expect(page.locator('.full-history')).toHaveCount(0);
  const signIn=page.getByRole('link',{name:'Sign in to view history',exact:true});await expect(signIn).toHaveAttribute('href',`/sign-in?returnTo=${encodeURIComponent(`/game/${gameId}?replay=1&move=1`)}`);await signIn.click();
  await page.locator('.auth-tabs').getByRole('link',{name:'Create account',exact:true}).click();await expect(page).toHaveURL(/returnTo=/);await page.locator('.auth-tabs').getByRole('link',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Username',{exact:true}).fill(user.username);await page.getByLabel('Password',{exact:true}).fill('FixturePassword123!');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page).toHaveURL(url=>url.pathname===`/game/${gameId}`&&url.search==='?replay=1&move=1');await expect(page.getByRole('slider',{name:'Replay move'})).toHaveValue('1');
  await expect(page.locator('.square.player-0')).toHaveCount(2);await expect(page.locator('.square.player-1')).toHaveCount(0);
  await page.getByRole('button',{name:'Next move',exact:true}).click();await expect(page).toHaveURL(/move=2$/);await expect(page.locator('.square.player-1')).toHaveCount(2);
});

test('each AI level posts the selected time and shows level and thinking state',async({page})=>{
  const state:{signedIn:boolean;active?:boolean;difficulty?:AiDifficulty}={signedIn:true};const requests:unknown[]=[];await simpleApi(page,state,body=>requests.push(body));
  for(const difficulty of ['easy','medium','hard'] as const){
    await page.goto('/');await page.getByRole('button',{name:'Computer',exact:true}).click();await page.getByRole('button',{name:difficulty[0]!.toUpperCase()+difficulty.slice(1),exact:true}).click();
    await page.getByRole('button',{name:/25\s*min Take your time/}).click();await page.getByRole('button',{name:'Play against AI',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`/game/${gameId}$`));expect(requests.at(-1)).toEqual({difficulty,minutes:25});
    await expect(page.locator('.ai-level')).toHaveText(`${difficulty[0]!.toUpperCase()+difficulty.slice(1)} AI · `);await expect(page.getByRole('heading',{name:`${difficulty[0]!.toUpperCase()+difficulty.slice(1)} AI is thinking`,exact:true})).toBeVisible();
  }
});

test('tutorial loads only on user request, chapter jumps work, and help preserves the live connection',async({page,browserName})=>{
  test.skip(browserName!=='chromium','Native H.264 playback is verified in the installed Chromium runtime.');
  const state={signedIn:true,active:true};const sockets=await simpleApi(page,state);const media:string[]=[];page.on('request',request=>{if(request.url().endsWith('.mp4'))media.push(request.url());});
  await page.goto(`/game/${gameId}`);await expect(page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();const before={...sockets};
  await page.getByRole('button',{name:'Game rules',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Game clocks keep running');expect(media).toEqual([]);
  await page.getByRole('tab',{name:'Video',exact:true}).click();const video=page.locator('video');await expect(video).toHaveAttribute('preload','none');await expect(video).not.toHaveAttribute('src',/.+/);expect(media).toEqual([]);
  await video.evaluate(element=>{element.muted=true;(window as unknown as {tutorialUnderTest:HTMLVideoElement}).tutorialUnderTest=element;});
  await page.getByRole('button',{name:'Play video tutorial',exact:true}).click();await expect.poll(()=>video.evaluate(element=>element.currentTime)).toBeGreaterThan(0);
  expect(media.length).toBeGreaterThan(0);expect(media.every(url=>url.includes('/tutorial/bestword-9fbe34a89b81/'))).toBe(true);await expect(video).toHaveJSProperty('controls',true);
  await page.getByRole('button',{name:'03:21 Scoring and bridges',exact:true}).click();await expect.poll(()=>video.evaluate(element=>element.currentTime)).toBeGreaterThanOrEqual(201);
  await page.getByRole('tab',{name:'Rules',exact:true}).click();await expect(page.locator('video')).toHaveCount(0);
  const stopped=await page.evaluate(()=>{const element=(window as unknown as {tutorialUnderTest:HTMLVideoElement}).tutorialUnderTest;return {paused:element.paused,src:element.getAttribute('src')};});expect(stopped).toEqual({paused:true,src:null});
  await page.getByRole('tab',{name:'Video',exact:true}).click();await page.locator('video').evaluate(element=>{element.muted=true;(window as unknown as {tutorialUnderTest:HTMLVideoElement}).tutorialUnderTest=element;});await page.getByRole('button',{name:'Play video tutorial',exact:true}).click();await expect.poll(()=>page.locator('video').evaluate(element=>element.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();expect(sockets).toEqual(before);
  expect(await page.evaluate(()=>{const element=(window as unknown as {tutorialUnderTest:HTMLVideoElement}).tutorialUnderTest;return {paused:element.paused,src:element.getAttribute('src')};})).toEqual({paused:true,src:null});
});

test('guest help and computer setup remain readable on desktop and small mobile screens',async({page},testInfo)=>{
  await simpleApi(page,{signedIn:false});const requests:string[]=[];page.on('request',request=>{if(request.url().includes('/tutorial/'))requests.push(request.url());});
  for(const [label,width,height] of [['desktop',1280,800],['phone',390,844],['small-phone',320,568]] as const){
    await page.setViewportSize({width,height});await page.goto('/');await page.getByRole('button',{name:'Computer',exact:true}).click();await page.getByRole('button',{name:'Hard',exact:true}).click();await page.locator('.create-card').scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await page.screenshot({path:testInfo.outputPath(`${label}-computer.png`)});
    const before=requests.length;await page.getByRole('button',{name:'Rules & how to play',exact:true}).click();expect(requests.length).toBe(before);
    await page.getByRole('tab',{name:'Video',exact:true}).click();await expect(page.locator('video')).not.toHaveAttribute('src',/.+/);await expect(page.getByRole('button',{name:'Play video tutorial',exact:true})).toBeVisible();
    const geometry=await page.getByRole('dialog').evaluate(dialog=>({width:dialog.clientWidth,scroll:dialog.scrollWidth,left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right}));expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);expect(geometry.left).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(width);
    await page.screenshot({path:testInfo.outputPath(`${label}-tutorial.png`)});await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  }
  expect(requests.filter(url=>url.endsWith('.mp4'))).toEqual([]);
});

function summary(value:number):GameSummary{return {id:`00000000-0000-4000-8000-${String(value).padStart(12,'0')}`,players:[user,opponent],scores:[value,1],minutes:15,status:'finished',result:{winner:0,reason:'both-passed',at:value},createdAt:value,spectatorCount:0};}
const range=(first:number,last:number)=>Array.from({length:first-last+1},(_,index)=>summary(first-index));
test('recent game refresh preserves expanded pages, scroll/focus and cursor during overlapping responses',async({page})=>{
  await page.clock.install({time:new Date()});let newest=1000,holdHead=false,holdMore=false;let releaseHead=()=>{},releaseMore=()=>{};let headStarted=0,moreStarted=0;const cursors:string[]=[];
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/session'){await route.fulfill({json:{user:null,activeGameId:null}});return;}
    if(url.pathname!=='/api/games/history'){await route.fulfill({json:{items:[],nextCursor:null}});return;}
    expect(url.searchParams.get('limit')).toBe('50');const cursor=url.searchParams.get('cursor');
    if(cursor){cursors.push(cursor);const first=Number(cursor.slice(6));if(holdMore){holdMore=false;moreStarted++;await new Promise<void>(resolve=>releaseMore=resolve);}await route.fulfill({json:{items:range(first,first-49),nextCursor:`after-${first-50}`}});}
    else{const snapshot=newest;if(holdHead){holdHead=false;headStarted++;await new Promise<void>(resolve=>releaseHead=resolve);}await route.fulfill({json:{items:range(snapshot,snapshot-49),nextCursor:`after-${snapshot-50}`}});}
  });await wire(page,()=>fixtureView(false));
  await page.goto('/');await page.getByRole('tab',{name:'Recent games',exact:true}).click();await expect(page.locator('.game-row')).toHaveCount(50);
  await page.getByRole('button',{name:'Show more',exact:true}).click();await expect(page.locator('.game-row')).toHaveCount(100);expect(cursors).toEqual(['after-950']);
  const focused=page.locator(`[data-game-id="${summary(920).id}"]`);await focused.scrollIntoViewIfNeeded();await focused.focus();const top=(await focused.boundingBox())!.y;
  newest=1003;await page.clock.fastForward(15001);await expect(page.locator('.game-row')).toHaveCount(103);await expect(focused).toBeFocused();expect(Math.abs((await focused.boundingBox())!.y-top)).toBeLessThanOrEqual(1);
  holdMore=true;await page.getByRole('button',{name:'Show more',exact:true}).click();await expect.poll(()=>moreStarted).toBe(1);
  newest=1004;holdHead=true;await page.clock.fastForward(15001);await expect.poll(()=>headStarted).toBe(1);
  newest=1005;await page.clock.fastForward(15001);await expect(page.locator('.game-row')).toHaveCount(105);
  releaseMore();await expect(page.locator('.game-row')).toHaveCount(155);releaseHead();await expect(page.locator('.game-row')).toHaveCount(155);
  await expect(page.locator(`[data-game-id="${summary(1005).id}"]`)).toHaveCount(1);await expect(page.locator(`[data-game-id="${summary(851).id}"]`)).toHaveCount(1);
  await page.getByRole('button',{name:'Show more',exact:true}).click();await expect(page.locator('.game-row')).toHaveCount(205);expect(cursors).toEqual(['after-950','after-900','after-850']);
});


test('guest tutorial media supports native byte ranges and retains the original complete file',async({request})=>{
  const path='/tutorial/bestword-9fbe34a89b81/BestWord-Tutorial.mp4';
  const head=await request.head(path);expect(head.status()).toBe(200);expect(head.headers()['content-type']).toContain('video/mp4');expect(head.headers()['content-length']).toBe('16544578');expect(head.headers()['accept-ranges']).toBe('bytes');expect(head.headers()['cache-control']).toContain('immutable');expect(head.headers()['cache-control']).toContain('max-age=31536000');
  const range=await request.get(path,{headers:{Range:'bytes=0-1023'}});expect(range.status()).toBe(206);expect(range.headers()['content-range']).toBe('bytes 0-1023/16544578');expect((await range.body()).length).toBe(1024);
  const full=await request.get(path);expect(full.status()).toBe(200);expect(createHash('sha256').update(await full.body()).digest('hex')).toBe('9fbe34a89b81a63adf2653614849032775ee1c19a90a555736e5c9af326b78be');
  const missing=await request.get('/tutorial/bestword-9fbe34a89b81/missing.mp4');expect(missing.status()).toBe(404);expect(missing.headers()['cache-control']??'').not.toContain('immutable');expect(missing.headers()['content-type']??'').not.toContain('text/html');
});
