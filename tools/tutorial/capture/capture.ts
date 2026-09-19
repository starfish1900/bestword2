/** Genuine browser footage. Run from repository root: node --import tsx tools/tutorial/capture/capture.ts */
import { chromium, expect, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { Client } from 'pg';
import { createClient } from 'redis';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../../../apps/server/src/app.js';
import { readConfig } from '../../../apps/server/src/config.js';
import { findLegalPlacement } from '../../e2e/helpers.js';
import { isVowel, type GameView } from '@bestword/contracts';

const output=resolve(process.env.BESTWORD_TUTORIAL_CAPTURE_OUTPUT??'../../work/tutorial/capture');
const runId=randomUUID(),schema=`bw_tutorial_${runId.replaceAll('-','')}`;
const sourceDatabase='postgresql://bestword:bestword-local@127.0.0.1:54329/bestword';
const origin='http://127.0.0.1:3012';
const password=`Tutorial${randomBytes(16).toString('base64url')}!`;
const admin=new Client({connectionString:sourceDatabase});
let redis:ReturnType<typeof createClient>|undefined,redisDatabase=0,createdSchema=false;
let runtime:Awaited<ReturnType<typeof buildApp>>|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
type Recorder={name:string;context:BrowserContext;page:Page;epoch:number;size:{width:number;height:number}};
const recorders:Recorder[]=[];
const clips:{id:string;recorder:string;startSeconds:number;endSeconds:number;poster:string;description:string}[]=[];
const checks:Record<string,unknown>={};
const errors:string[]=[];
const report={version:1,runId,startedAt:new Date().toISOString(),kind:'Real local BestWord UI with isolated PostgreSQL schema and Redis logical database',status:'running',origin,redisDatabase:0,clips,recordings:[] as object[],checks,errors,cleanup:{apiClosed:false,schemaDropped:false,redisCleared:false}};
await mkdir(output,{recursive:true});
async function save(){await writeFile(join(output,'capture-manifest.json'),JSON.stringify(report,null,2)+'\n');}
function elapsed(rec:Recorder){return (performance.now()-rec.epoch)/1000;}
async function record(name:string,mobile=false,storageState?:Awaited<ReturnType<BrowserContext['storageState']>>):Promise<Recorder>{
  const size=mobile?{width:390,height:844}:{width:1280,height:720};
  const context=await browser!.newContext({baseURL:origin,viewport:size,deviceScaleFactor:1,hasTouch:mobile,recordVideo:{dir:join(output,'raw'),size},...(storageState?{storageState}:{})});
  context.setDefaultTimeout(12000);
  await context.addInitScript(()=>{
    window.addEventListener('DOMContentLoaded',()=>{
      const marker=document.createElement('div');marker.id='tutorial-pointer';
      marker.style.cssText='position:fixed;left:-100px;top:-100px;width:26px;height:26px;border:2px solid #f0c56e;border-radius:50%;background:#e8bc5c30;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:width .12s,height .12s;box-shadow:0 0 0 2px #09203388';
      document.body.append(marker);
      document.addEventListener('pointermove',event=>{marker.style.left=`${event.clientX}px`;marker.style.top=`${event.clientY}px`;});
      document.addEventListener('pointerdown',event=>{marker.style.left=`${event.clientX}px`;marker.style.top=`${event.clientY}px`;marker.style.width='36px';marker.style.height='36px';});
      document.addEventListener('pointerup',()=>{marker.style.width='26px';marker.style.height='26px';});
    });
  });
  const epoch=performance.now(),page=await context.newPage();
  page.on('pageerror',error=>errors.push(`${name}: ${error.message}`));
  const recorder={name,context,page,epoch,size};recorders.push(recorder);return recorder;
}
async function click(rec:Recorder,target:Locator,touch=false){
  await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();if(!box)throw Error('Target has no rectangle');
  if(touch)await target.tap();else{await rec.page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:14});await delay(220);await target.click();}
  await delay(550);
}
async function clip(rec:Recorder,id:string,description:string,fn:()=>Promise<void>){
  const startSeconds=elapsed(rec);console.log(`Capturing ${id}`);await fn();
  const poster=`${id}.png`;await rec.page.screenshot({path:join(output,poster)});await delay(750);
  clips.push({id,recorder:rec.name,startSeconds,endSeconds:elapsed(rec),poster,description});await save();
}
async function register(rec:Recorder,username:string){
  await rec.page.goto('/sign-up');await expect(rec.page.getByRole('button',{name:'Create account',exact:true})).toBeVisible();await delay(700);
  await click(rec,rec.page.getByLabel('Username',{exact:true}));await rec.page.keyboard.type(username,{delay:90});
  await click(rec,rec.page.getByLabel('Password',{exact:true}));await rec.page.getByLabel('Password',{exact:true}).fill(password);await delay(600);
  await click(rec,rec.page.getByRole('button',{name:'Create account',exact:true}));await expect(rec.page.getByRole('heading',{name:'Find your next game'})).toBeVisible();
}
async function clock(rec:Recorder){const text=await rec.page.locator('.player-card.active time').innerText();const [minutes,seconds]=text.split(':').map(Number);return {text,seconds:minutes!*60+seconds!};}
try{
  await admin.connect();
  for(let candidate=14;candidate>=1;candidate--){
    const client=createClient({url:`redis://127.0.0.1:6389/${candidate}`,disableOfflineQueue:true});client.on('error',()=>{});await client.connect();
    const claimed=Number(await client.eval("if redis.call('DBSIZE')==0 then redis.call('SET',KEYS[1],ARGV[1]);return 1 end;return 0",{keys:['bw:tutorial-owner'],arguments:[runId]}));
    if(claimed){redis=client;redisDatabase=candidate;break;}await client.close();
  }
  if(!redis)throw Error('No empty nonzero Redis logical database is available.');
  await admin.query(`CREATE SCHEMA "${schema}"`);createdSchema=true;
  const databaseUrl=new URL(sourceDatabase);databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
  runtime=await buildApp(readConfig({...process.env,NODE_ENV:'test',PORT:'3012',HOST:'127.0.0.1',APP_ORIGIN:origin,DATABASE_URL:databaseUrl.toString(),REDIS_URL:`redis://127.0.0.1:6389/${redisDatabase}`,LOG_LEVEL:'warn'}));
  await runtime.app.listen({host:'127.0.0.1',port:3012});report.redisDatabase=redisDatabase;
  browser=await chromium.launch({headless:true});
  const alice=await record('alice');
  await clip(alice,'account','Actual registration with a disposable tutorial account.',()=>register(alice,'AliceDemo'));
  // Create each recorder immediately before its first navigation: Chromium starts
  // its recording timeline on its first rendered page, not on an idle blank tab.
  const bob=await record('sam');
  await register(bob,'SamDemo');
  const login=await record('sign-in');
  await login.page.goto('/sign-in');await expect(login.page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  await clip(login,'sign-in','Actual sign-in with the tutorial account.',async()=>{
    await delay(700);await click(login,login.page.getByLabel('Username',{exact:true}));await login.page.keyboard.type('AliceDemo',{delay:95});
    await click(login,login.page.getByLabel('Password',{exact:true}));await login.page.getByLabel('Password',{exact:true}).fill(password);await delay(700);
    await click(login,login.page.getByRole('button',{name:'Sign in',exact:true}));await expect(login.page.getByRole('heading',{name:'Find your next game'})).toBeVisible();await delay(1500);
  });
  await clip(alice,'lobby','Actual choice of 5, 15 and 25 minute tables, then creating a 15 minute table.',async()=>{
    for(const minutes of [5,25,15])await click(alice,alice.page.locator('.time-option').filter({has:alice.page.locator('strong',{hasText:new RegExp(`^${minutes}$`)})}));
    await click(alice,alice.page.getByRole('button',{name:'Create a game',exact:true}));await expect(alice.page.locator('.your-seek')).toBeVisible();await delay(2200);
  });
  await expect(bob.page.locator('.seek-row').filter({hasText:'AliceDemo'})).toBeVisible();
  await clip(bob,'setup','Joining a real open table; automatic random starting board and countdown.',async()=>{
    await delay(1000);await click(bob,bob.page.locator('.seek-row').filter({hasText:'AliceDemo'}).getByRole('button',{name:'Join',exact:true}));
    await expect(bob.page).toHaveURL(/\/game\/[\da-f-]+$/);await expect(alice.page).toHaveURL(bob.page.url());await delay(5500);
  });
  const gameId=bob.page.url().split('/').at(-1)!;
  const read=async(rec=alice):Promise<GameView>=>{const response=await rec.context.request.get(`/api/games/${gameId}`);expect(response.ok()).toBe(true);return response.json() as Promise<GameView>;};
  await expect.poll(async()=>{const view=await read();return view.game.status==='active'&&view.game.startsAt===null;}).toBe(true);
  const initial=await read(),actor=initial.you?.seat===initial.game.activeSeat?alice:bob,other=actor===alice?bob:alice;
  checks.gameId=gameId;checks.initialWords=initial.game.principalHistory;checks.initialScore=initial.game.players.map(player=>player.score);
  await clip(actor,'clocks','Visible active player clock counts down; opponent clock remains stopped.',async()=>{
    const before=await clock(actor),otherBefore=await actor.page.locator('.player-card:not(.active) time').innerText();await delay(6000);
    const after=await clock(actor),otherAfter=await actor.page.locator('.player-card:not(.active) time').innerText();
    expect(before.seconds-after.seconds).toBeGreaterThanOrEqual(5);expect(otherAfter).toBe(otherBefore);checks.playerClock={before,after,otherBefore,otherAfter};
  });
  const placement=await findLegalPlacement(await read(actor));
  await clip(actor,'invalid','A rejected two-letter move keeps its draft while the clock continues.',async()=>{
    const view=await read(actor),empty=view.game.board.findIndex((letter,index)=>!letter&&index%15<13&&!view.game.board[index+1]&&!view.game.board[index+2]&&(index%15===0||!view.game.board[index-1]));
    if(empty<0)throw Error('No suitable empty teaching location');
    await click(actor,actor.page.locator(`#square-${empty}`));await actor.page.keyboard.type('AE',{delay:500});await delay(1200);
    await actor.page.keyboard.press('Enter');await expect(actor.page.locator('.game-message')).not.toBeEmpty();await expect(actor.page.locator('.draft-tile')).toHaveCount(2);await delay(2400);
    checks.rejection={draftTilesRetained:2,moveCount:(await read(actor)).game.moves.length};await actor.page.keyboard.press('Escape');
  });
  await clip(actor,'keyboard','Actual direction toggles, letter entry, Backspace, retype and Enter submission.',async()=>{
    const first=placement.tiles[0]!,target=actor.page.locator(`#square-${first.row*15+first.column}`);
    await click(actor,target);await delay(850);await click(actor,target);await delay(850);
    const expected=placement.action.direction==='H'?'horizontal cursor':'vertical cursor';
    if(!(await target.getAttribute('aria-label'))?.includes(expected))await click(actor,target);
    await actor.page.keyboard.type(placement.tiles.map(tile=>tile.letter).join(''),{delay:650});await delay(800);
    await actor.page.keyboard.press('Backspace');await expect(actor.page.locator('.draft-tile')).toHaveCount(placement.tiles.length-1);await delay(950);
    await actor.page.keyboard.type(placement.tiles.at(-1)!.letter);await delay(1700);
    const before=await read(actor);
    // Retain actual displayed intermediate values as evidence the recording shows a count-up.
    const sampled=actor.page.locator('.player-card.you .score-value').evaluate(async element=>{
      const values:{value:number;at:number}[]=[],start=performance.now();
      values.push({value:Number(element.textContent),at:performance.now()-start});
      const observer=new MutationObserver(()=>values.push({value:Number(element.textContent),at:performance.now()-start}));observer.observe(element,{childList:true,subtree:true,characterData:true});
      await new Promise(resolve=>setTimeout(resolve,2600));observer.disconnect();values.push({value:Number(element.textContent),at:performance.now()-start});return values;
    }).then(samples=>({samples,error:null}),error=>({samples:[],error}));
    await actor.page.keyboard.press('Enter');await expect.poll(async()=>(await read(actor)).game.moves.length).toBe(1);await delay(2200);
    const after=await read(actor),sampleResult=await sampled,scoreSamples=sampleResult.samples,oldScore=before.game.players[before.you!.seat].score,newScore=after.game.players[before.you!.seat].score;
    if(sampleResult.error)throw sampleResult.error;
    expect(scoreSamples.some(sample=>sample.value>oldScore&&sample.value<newScore)).toBe(true);
    expect(scoreSamples.at(-1)!.value).toBe(newScore);
    expect(scoreSamples.every((sample,index)=>index===0||sample.value>=scoreSamples[index-1]!.value)).toBe(true);
    checks.keyboard={word:placement.action.word,tiles:placement.tiles,acceptedMove:after.game.moves[0],clockBeforeMs:before.game.clocksMs[before.you!.seat],clockAfterMs:after.game.clocksMs[before.you!.seat],scoreSamples};
  });
  const spectator=await record('spectator');await spectator.page.goto(`/game/${gameId}`);await expect(spectator.page.locator('.game-format')).toContainText('Spectating');
  await clip(spectator,'spectator','Unauthenticated real spectator; both clocks and public counts, private rack letters hidden.',async()=>{
    await expect(spectator.page.locator('.rack-tile')).toHaveCount(0);await expect(spectator.page.locator('.spectator-racks')).toBeVisible();
    const before=await clock(spectator);await delay(6500);const after=await clock(spectator);expect(before.seconds-after.seconds).toBeGreaterThanOrEqual(5);
    const view=await read(spectator);expect(view.you).toBeNull();checks.spectator={before,after,privateRackTileCount:0,anonymous:true};
  });
  const mobile=await record('mobile',true,await other.context.storageState());await mobile.page.goto(`/game/${gameId}`);await expect(mobile.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();
  const mobilePlacement=await findLegalPlacement(await read(mobile),tiles=>tiles.some(tile=>isVowel(tile.letter))&&tiles.some(tile=>!isVowel(tile.letter)));
  await clip(mobile,'mobile','Real mobile touchscreen move using rack and vowel taps, erase and submit.',async()=>{
    const first=mobilePlacement.tiles[0]!,target=mobile.page.locator(`#square-${first.row*15+first.column}`);await click(mobile,target,true);
    if(mobilePlacement.action.direction==='V')await click(mobile,target,true);
    const tapLetter=async(letter:string)=>click(mobile,isVowel(letter as never)?mobile.page.locator('.vowel-tile').filter({has:mobile.page.locator('strong',{hasText:new RegExp(`^${letter}`)})}):mobile.page.locator('.rack-tile:not(:disabled)').filter({hasText:new RegExp(`^${letter}`)}).first(),true);
    for(const tile of mobilePlacement.tiles)await tapLetter(tile.letter);await delay(1000);
    await click(mobile,mobile.page.getByRole('button',{name:'Erase last letter',exact:true}),true);await tapLetter(mobilePlacement.tiles.at(-1)!.letter);await delay(900);
    await click(mobile,mobile.page.getByRole('button',{name:'Play word',exact:true}),true);await expect.poll(async()=>(await read()).game.moves.length).toBe(2);await delay(1800);
    checks.mobile={word:mobilePlacement.action.word,tiles:mobilePlacement.tiles,acceptedMove:(await read()).game.moves[1],viewport:mobile.size};
  });
  await clip(actor,'no-words','Real NO WORDS skips only the current turn.',async()=>{
    await expect(actor.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();await delay(1200);
    await click(actor,actor.page.getByRole('button',{name:'No words',exact:true}));await expect.poll(async()=>(await read()).game.moves.length).toBe(3);await delay(2200);
  });
  await clip(other,'pass','Permanent pass confirmation and opponent continuing alone.',async()=>{
    await expect(other.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();await delay(1000);
    await click(other,other.page.getByRole('button',{name:'Pass forever',exact:true}));await delay(3000);
    await click(other,other.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}));await delay(3000);
  });
  await clip(actor,'finish','Second permanent pass ends the real game and declares its result.',async()=>{
    await click(actor,actor.page.getByRole('button',{name:'Pass forever',exact:true}));await delay(1600);
    await click(actor,actor.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}));await expect.poll(async()=>(await read()).game.status).toBe('finished');await delay(2300);
  });
  await clip(actor,'history','Actual move history with the server-computed scoring breakdown.',async()=>{
    await click(actor,actor.page.getByRole('button',{name:'Move history',exact:true}));await delay(5500);
  });
  await actor.page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();
  await clip(actor,'replay','Actual opening position, forward moves and automatic replay.',async()=>{
    await click(actor,actor.page.getByRole('button',{name:'Explore the replay'}));await delay(1500);
    await click(actor,actor.page.getByRole('button',{name:'Next move',exact:true}));await delay(1500);
    await click(actor,actor.page.getByRole('button',{name:'Next move',exact:true}));await delay(1600);
    await click(actor,actor.page.getByRole('button',{name:'First position',exact:true}));await click(actor,actor.page.getByRole('button',{name:'Play',exact:true}));await delay(7500);
  });
  const final=await read();checks.actions=final.game.moves.map(move=>move.action);checks.finalStatus=final.game.status;checks.result=final.game.result;
  expect(checks.actions).toEqual(['PLACE_WORD','PLACE_WORD','NO_WORDS','PASS','PASS']);expect(errors).toEqual([]);
  report.status='completed';
}catch(error){report.status='failed';errors.push(error instanceof Error?error.stack??error.message:String(error));throw error;}
finally{
  for(const recorder of recorders){
    try{const video=recorder.page.video();await recorder.context.close();if(video){const file=`${recorder.name}.webm`;await video.saveAs(join(output,file));report.recordings.push({id:recorder.name,file,width:recorder.size.width,height:recorder.size.height,timeline:'Seconds relative to page creation; final frame audit may apply a constant initial offset.'});}}
    catch(error){errors.push(`Recording close: ${String(error)}`);}
  }
  await browser?.close();
  if(runtime){await runtime.close();report.cleanup.apiClosed=true;}
  if(redis){
    if(await redis.get('bw:tutorial-owner')!==runId)throw Error('Redis ownership changed; refusing cleanup.');
    const keys=await redis.keys('bw:*');if(keys.length)await redis.del(keys);report.cleanup.redisCleared=true;await redis.close();
  }
  if(createdSchema){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);report.cleanup.schemaDropped=true;}
  await admin.end();await save();console.log(JSON.stringify({status:report.status,clips:clips.length,output,errors,cleanup:report.cleanup}));
}
