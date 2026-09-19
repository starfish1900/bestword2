import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { Worker } from 'node:worker_threads';
import { AI_POLICY_VERSION,findBestMove } from '@bestword/ai';
import { VOWELS,type GameAction,type User } from '@bestword/contracts';
import { assertStateInvariants,type EngineState } from '@bestword/engine';
import { Gaddag } from '@bestword/lexicon';
import { readConfig } from '../src/config.js';
import { AI_USERS,createDatabase,databaseNow,migrate,transaction,type AiCapabilities,type Database } from '../src/db.js';
import { createKeyValue,type KeyValue } from '../src/kv.js';
import { Games } from '../src/games.js';
import { Health } from '../src/health.js';
import { aiPositionKey,claimAiJob,releaseAiClaim,renewAiClaim } from '../src/ai-jobs.js';
import * as jobService from '../src/ai-jobs.js';
import { AiCoordinator } from '../src/ai-coordinator.js';

const enabled=process.env.BESTWORD_INTEGRATION==='1';
const base=process.env.BESTWORD_TEST_DATABASE_URL??process.env.DATABASE_URL??'postgresql://bestword:bestword-local@127.0.0.1:54329/bestword';
const redis=process.env.BESTWORD_TEST_REDIS_URL??process.env.REDIS_URL??'redis://127.0.0.1:6389';
describe.skipIf(!enabled)('durable server AI against real PostgreSQL and Redis',()=>{
  let admin:Database,db:Database,kv:KeyValue,schema:string,games:Games,api:Health,ai:Health;
  let full:Gaddag,easy:Gaddag,medium:Gaddag,capabilities:AiCapabilities;
  const healths:Health[]=[],coordinators:AiCoordinator[]=[];
  beforeAll(async()=>{admin=createDatabase(base,2);[full,easy,medium]=await Promise.all([Gaddag.open('data/lexicon.bin.gz'),Gaddag.open('data/easy.gaddag'),Gaddag.open('data/medium.gaddag')]);capabilities={policyVersion:AI_POLICY_VERSION,vocabularies:{easy:easy.sha256,medium:medium.sha256,hard:full.sha256}};});
  beforeEach(async()=>{
    schema=`ai_${randomUUID().replaceAll('-','')}`;await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(base);url.searchParams.set('options',`-c search_path=${schema}`);db=createDatabase(url.toString(),8);await migrate(db);
    kv=createKeyValue(redis);await kv.connect();api=new Health(db,kv,'api');ai=new Health(db,kv,'ai',capabilities);healths.push(api,ai);await api.start();await ai.start();
    games=new Games(db,kv,api,full,readConfig({NODE_ENV:'test',DATABASE_URL:url.toString(),REDIS_URL:redis,LOG_LEVEL:'silent',AI_MAX_GAMES:'10',AI_LOOKAHEAD_MS:'0',WORKER_INTERVAL_MS:'50'}));
  });
  afterEach(async()=>{
    vi.restoreAllMocks();
    for(const coordinator of coordinators.splice(0))await coordinator.stop();
    for(const health of healths.splice(0))await health.stop();
    const ids=(await db.pool.query<{id:string}>('SELECT id FROM games')).rows.map(row=>row.id);
    for(const id of ids)await kv.del([`bw:presence:${id}:0`,`bw:presence:${id}:1`,`bw:spectators:${id}`]);
    await kv.close();await db.pool.end();await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  afterAll(async()=>{await admin?.pool.end();});
  async function human():Promise<User>{const user={id:randomUUID(),username:`P${randomUUID().replaceAll('-','').slice(0,10)}`};await db.pool.query('INSERT INTO users(id,username,username_key,password_hash,created_at) VALUES($1,$2,$3,\'fixture\',0)',[user.id,user.username,user.username.toLowerCase()]);return user;}
  async function save(state:EngineState):Promise<void>{await db.pool.query('UPDATE games SET state=$2,revision=$3,status=$4,next_check=0,next_deadline=$5 WHERE id=$1',[state.id,JSON.stringify(state),state.revision,state.status,state.turnDeadlineAt]);}
  async function current(id:string):Promise<EngineState>{return (await games.read(id)).state;}
  async function active(difficulty:'easy'|'medium'|'hard'='hard'):Promise<{id:string;user:User;member:string;state:EngineState}>{
    const user=await human(),id=await games.createAi(user,difficulty,5),member=`${api.epoch}/${randomUUID()}`;
    await games.connect(id,user,member,true);let state=await current(id);const now=await transaction(db,databaseNow);
    state.startsAt=Math.max(state.lastTransitionAt,now-1);await save(state);await games.tick();state=await current(id);
    expect(state.status).toBe('active');
    if(state.activeSeat===0){expect((await games.command({gameId:id,commandId:randomUUID(),expectedRevision:state.revision,action:{type:'NO_WORDS'}},user)).ok).toBe(true);state=await current(id);}
    expect(state.activeSeat).toBe(1);return {id,user,member,state};
  }
  function action(state:EngineState,lexicon=full):GameAction{
    const found=findBestMove({board:state.board,rack:state.players[1].rack,vowels:Object.fromEntries(VOWELS.map(letter=>[letter,state.bag[letter]])) as Record<typeof VOWELS[number],number>,principalHistory:state.principalHistory},lexicon);
    expect(found.complete).toBe(true);return found.move??{type:state.drawnThisTurn[1]>0&&!state.players[0].passed?'NO_WORDS':'PASS'};
  }
  it('admits only ready, authenticated human players and keeps the shared bot out of playing slots',async()=>{
    await expect(games.createAi(AI_USERS.easy,'easy',5)).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    const first=await human(),second=await human();const a=await games.createAi(first,'easy',15),b=await games.createAi(second,'easy',5);
    expect((await current(a)).ai).toEqual({seat:1,difficulty:'easy',vocabularyHash:easy.sha256,policyVersion:AI_POLICY_VERSION});
    expect((await current(a)).players[1].id).toBe((await current(b)).players[1].id);
    expect((await db.pool.query('SELECT 1 FROM playing_slots WHERE user_id=$1',[AI_USERS.easy.id])).rowCount).toBe(0);
    await expect(games.createAi(first,'hard',5)).rejects.toMatchObject({code:'ALREADY_PLAYING'});
    await ai.stop();await expect(games.createAi(await human(),'medium',5)).rejects.toMatchObject({code:'AI_UNAVAILABLE'});
  });
  it('enforces a separate AI admission cap and removes the human open seek atomically',async()=>{
    games.config.AI_MAX_GAMES=1;const user=await human();await db.pool.query('INSERT INTO seeks(id,user_id,minutes,created_at,expires_at) VALUES($1,$2,5,0,$3)',[randomUUID(),user.id,Date.now()+60000]);
    await games.createAi(user,'medium',5);expect((await db.pool.query('SELECT 1 FROM seeks WHERE user_id=$1',[user.id])).rowCount).toBe(0);
    await expect(games.createAi(await human(),'hard',5)).rejects.toMatchObject({code:'AI_CAPACITY_REACHED'});
    expect(await games.aiAvailability()).toMatchObject({available:false,activeGames:1,maxGames:1});
  });
  it('starts with one real game connection and keeps bot presence distinct from browser presence',async()=>{
    const table=await active();expect(table.state.players[1].connected).toBe(true);expect(table.state.disconnectDeadlines[1]).toBeNull();
    expect((await db.pool.query('SELECT 1 FROM ai_jobs WHERE game_id=$1',[table.id])).rowCount).toBe(1);
    await expect(games.connect(table.id,AI_USERS.hard,`${api.epoch}/forged`,true)).rejects.toMatchObject({code:'NOT_A_PLAYER'});
    await games.connect(table.id,table.user,table.member,false);const disconnected=await current(table.id);
    expect(disconnected.disconnectDeadlines[0]).not.toBeNull();expect(disconnected.disconnectDeadlines[1]).toBeNull();
  });
  it('fences duplicate claims and expired owners, applies once, and returns the durable receipt',async()=>{
    const table=await active();const claims=await Promise.all([claimAiJob(db,ai.epoch,capabilities),claimAiJob(db,ai.epoch,capabilities)]);
    expect(claims.filter(Boolean)).toHaveLength(1);const old=claims.find(Boolean)!;
    await db.pool.query('UPDATE ai_jobs SET leased_until=0 WHERE game_id=$1',[table.id]);const fresh=(await claimAiJob(db,ai.epoch,capabilities))!;
    const decision={complete:true,action:action(table.state)};
    expect(await games.commitAiClaim(old,decision,full)).toEqual({accepted:false});expect(await renewAiClaim(db,old)).toBe(false);
    const result=await games.commitAiClaim(fresh,decision,full);expect(result.accepted).toBe(true);expect(await games.commitAiClaim(fresh,decision,full)).toEqual(result);
    const saved=await current(table.id);expect(saved.moves.length).toBe(table.state.moves.length+1);assertStateInvariants(saved);
    expect((await db.pool.query('SELECT 1 FROM commands WHERE game_id=$1 AND user_id=$2',[table.id,AI_USERS.hard.id])).rowCount).toBe(1);
  });
  it('retains a valid search through human presence revisions without leaking private state',async()=>{
    const table=await active();const claim=(await claimAiJob(db,ai.epoch,capabilities))!;
    await games.connect(table.id,table.user,table.member,false);await games.connect(table.id,table.user,table.member,true);
    const changed=await current(table.id);expect(changed.revision).toBeGreaterThan(table.state.revision);expect(aiPositionKey(changed)).toBe(claim.job.position_key);
    expect((await games.commitAiClaim(claim,{complete:true,action:action(claim.state)},full)).accepted).toBe(true);
    const view=await games.view(table.id);expect(view.you).toBeNull();expect(view.game.ai).toEqual({seat:1,difficulty:'hard'});
    expect(JSON.stringify(view)).not.toMatch(/consonantDrawOrder|drawnThisTurn|vocabularyHash|policyVersion|"rack":/);
  });
  it('rejects an incomplete search and a vocabulary mismatch without applying any move',async()=>{
    const table=await active();const claim=(await claimAiJob(db,ai.epoch,capabilities))!;
    expect(await games.commitAiClaim(claim,{complete:false,action:action(claim.state)},full)).toEqual({accepted:false});
    await expect(games.commitAiClaim(claim,{complete:true,action:action(claim.state)},easy)).rejects.toThrow('dictionary version');
    expect((await current(table.id)).moves).toHaveLength(table.state.moves.length);await releaseAiClaim(db,claim);
  });
  it('charges the AI clock and applies its deadline before a late search result',async()=>{
    const table=await active();const state=await current(table.id),now=await transaction(db,databaseNow);
    state.clocksMs[1]=50;state.turnStartedAt=now;state.turnDeadlineAt=now+50;state.lastTransitionAt=now;await save(state);
    const claim=(await claimAiJob(db,ai.epoch,capabilities))!;const selected=action(state);await delay(75);await api.tick();await ai.tick();
    expect(await games.commitAiClaim(claim,{complete:true,action:selected},full)).toEqual({accepted:false});
    const saved=await current(table.id);expect(saved.result).toMatchObject({reason:'clock',winner:0});expect(saved.moves).toHaveLength(state.moves.length);
  });
  it('records an AI crash as infrastructure loss and invalidates its work during pause',async()=>{
    const table=await active();const claim=(await claimAiJob(db,ai.epoch,capabilities))!;
    // Simulate a vanished process after its last trustworthy checkpoint, without graceful shutdown.
    clearInterval(Reflect.get(ai,'timer') as NodeJS.Timeout);await delay(3100);
    await db.pool.query('UPDATE games SET next_check=0 WHERE id=$1',[table.id]);
    await games.tick();const paused=await current(table.id);expect(paused.status).toBe('paused');expect(paused.result).toBeNull();
    expect(await renewAiClaim(db,claim)).toBe(false);expect(await games.commitAiClaim(claim,{complete:true,action:action(claim.state)},full)).toEqual({accepted:false});
    expect((await current(table.id)).moves).toHaveLength(table.state.moves.length);
  });
  it('pauses on AI service loss, refuses false API-only recovery, and resumes through a replacement worker',async()=>{
    const table=await active();await ai.stop();await games.tick();let state=await current(table.id);expect(state.status).toBe('paused');expect(state.result).toBeNull();
    await api.tick();await games.tick();state=await current(table.id);expect(state.pause?.recoveryDeadlineAt).toBeNull();
    expect((await db.pool.query('SELECT 1 FROM incidents WHERE epoch_id=$1 AND recovered_at IS NULL',[ai.epoch])).rowCount).toBe(1);
    const replacement=new Health(db,kv,'ai',capabilities);healths.push(replacement);await replacement.start();await db.pool.query('UPDATE games SET next_check=0 WHERE id=$1',[table.id]);await games.tick();
    state=await current(table.id);expect(state.status).toBe('active');expect(state.startsAt).not.toBeNull();expect(state.result).toBeNull();expect(state.moves).toHaveLength(table.state.moves.length);
  });
  it('keeps games running when another compatible AI replica remains healthy',async()=>{
    const second=new Health(db,kv,'ai',capabilities);healths.push(second);await second.start();const table=await active();await ai.stop();await games.tick();
    const state=await current(table.id);expect(state.status).toBe('active');expect(state.pause).toBeNull();expect(state.players[1].connected).toBe(true);
  });
  it('pins easy and medium games to the full dictionary as well as their restricted vocabulary',async()=>{
    for(const difficulty of ['easy','medium'] as const){
      const table=await active(difficulty),incompatible={...capabilities,vocabularies:{...capabilities.vocabularies,hard:'f'.repeat(64)}};
      const replacement=new Health(db,kv,'ai',incompatible);healths.push(replacement);await replacement.start();
      expect(await claimAiJob(db,replacement.epoch,incompatible)).toBeNull();
      const compatible=await transaction(db,async c=>api.aiWorkers(c,await databaseNow(c),table.state));expect(compatible.map(worker=>worker.id)).not.toContain(replacement.epoch);
      await replacement.stop();
    }
    await ai.stop();const incompatible={...capabilities,vocabularies:{...capabilities.vocabularies,hard:'f'.repeat(64)}};
    const replacement=new Health(db,kv,'ai',incompatible);healths.push(replacement);await replacement.start();
    await db.pool.query('UPDATE games SET next_check=0');await games.tick();
    const rows=await db.pool.query<{status:string}>('SELECT status FROM games');expect(rows.rows.every(row=>row.status==='paused')).toBe(true);
    expect((await games.aiAvailability()).available).toBe(false);expect(await claimAiJob(db,replacement.epoch,incompatible)).toBeNull();
    await expect(games.createAi(await human(),'easy',5)).rejects.toMatchObject({code:'AI_UNAVAILABLE'});
  });
  it('allows human PASS to release the slot while consecutive AI turns remain durable',async()=>{
    const table=await active();let claim=(await claimAiJob(db,ai.epoch,capabilities))!;
    await games.commitAiClaim(claim,{complete:true,action:action(claim.state)},full);let state=await current(table.id);
    if(state.players[1].passed)return;
    expect((await games.command({gameId:table.id,commandId:randomUUID(),expectedRevision:state.revision,action:{type:'PASS'}},table.user)).ok).toBe(true);
    expect((await db.pool.query('SELECT 1 FROM playing_slots WHERE user_id=$1',[table.user.id])).rowCount).toBe(0);
    claim=(await claimAiJob(db,ai.epoch,capabilities))!;expect(claim).not.toBeNull();expect(claim.state.players[0].passed).toBe(true);
    await games.commitAiClaim(claim,{complete:true,action:action(claim.state)},full);state=await current(table.id);
    if(state.status!=='finished'){expect(state.activeSeat).toBe(1);expect((await db.pool.query("SELECT 1 FROM ai_jobs WHERE game_id=$1 AND status='queued'",[table.id])).rowCount).toBe(1);}
  });
  it('executes a real search thread and commits an easy move with the production engine',async()=>{
    const table=await active('easy');const workerHealth=new Health(db,kv,'ai',capabilities);healths.push(workerHealth);
    const workerGames=new Games(db,kv,workerHealth,full,games.config);const failures:Error[]=[];
    const coordinator=new AiCoordinator(workerGames,games.config,capabilities,{easy,medium,hard:full},error=>failures.push(error));coordinators.push(coordinator);await coordinator.start();
    const deadline=Date.now()+15000;let state=await current(table.id);
    while(state.moves.length===table.state.moves.length&&Date.now()<deadline){await delay(50);state=await current(table.id);}
    expect(failures).toEqual([]);expect(state.moves.length).toBe(table.state.moves.length+1);expect(coordinator.metrics.completed).toBe(1);
    for(const word of state.moves.at(-1)!.words)expect(easy.has(word.word)).toBe(true);assertStateInvariants(state);
  });
  it('withdraws AI readiness after an actual search-thread crash and shares shutdown completion',async()=>{
    const workerHealth=new Health(db,kv,'ai',capabilities);healths.push(workerHealth);const failures:Error[]=[];
    const coordinator=new AiCoordinator(new Games(db,kv,workerHealth,full,games.config),games.config,capabilities,{easy,medium,hard:full},error=>failures.push(error));coordinators.push(coordinator);
    await coordinator.start();await ai.stop();const table=await active('medium');
    const slots=Reflect.get(coordinator,'slots') as Array<{worker:Worker}>;await slots[0]!.worker.terminate();
    const first=coordinator.stop(),second=coordinator.stop();expect(second).toBe(first);await first;
    expect(failures).toHaveLength(1);expect(workerHealth.ready).toBe(false);expect((await games.aiAvailability()).available).toBe(false);
    await db.pool.query('UPDATE games SET next_check=0 WHERE id=$1',[table.id]);await games.tick();expect((await current(table.id)).status).toBe('paused');
  });
  it('releases a claim that finishes acquiring while the coordinator is shutting down',async()=>{
    const table=await active();const claim=(await claimAiJob(db,ai.epoch,capabilities))!;
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    vi.spyOn(jobService,'claimAiJob').mockImplementationOnce(async()=>{entered();await gate;return claim;});
    const workerHealth=new Health(db,kv,'ai',capabilities);healths.push(workerHealth);
    const coordinator=new AiCoordinator(new Games(db,kv,workerHealth,full,games.config),games.config,capabilities,{easy,medium,hard:full});coordinators.push(coordinator);
    await coordinator.start();await started;const stopped=coordinator.stop();release();await stopped;
    expect((await db.pool.query<{status:string}>('SELECT status FROM ai_jobs WHERE game_id=$1 AND turn_number=$2',[table.id,claim.job.turn_number])).rows[0]!.status).toBe('queued');
    expect((await current(table.id)).moves).toHaveLength(table.state.moves.length);
  });
});
