import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, setConnected, startIfReady, type EngineState } from '@bestword/engine';
import { createDatabase, databaseNow, migrate, transaction, type Database } from '../src/db.js';
import { Health } from '../src/health.js';
import { createKeyValue, type KeyValue } from '../src/kv.js';

// These tests create their own PostgreSQL schema and only PING Redis. They never
// truncate application data, flush shared Redis keys, or stop either service.
const integrationEnabled=process.env['BESTWORD_INTEGRATION']==='1'||Boolean(process.env['BESTWORD_TEST_DATABASE_URL']);
const connectionString=process.env['BESTWORD_TEST_DATABASE_URL']??process.env['DATABASE_URL'];
const redisUrl=process.env['BESTWORD_TEST_REDIS_URL']??process.env['REDIS_URL'];
describe.skipIf(!integrationEnabled)('health authority against real PostgreSQL and Redis',()=>{
  let admin:Database,db:Database,kv:KeyValue;
  const schema=`health_${randomUUID().replaceAll('-','')}`;
  const services:Health[]=[];
  beforeAll(async()=>{
    if(!connectionString||!redisUrl)throw new Error('Health integration tests require DATABASE_URL and REDIS_URL (or BESTWORD_TEST_ overrides).');
    admin=createDatabase(connectionString!,2);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(connectionString!);url.searchParams.set('options',`-c search_path=${schema}`);
    db=createDatabase(url.toString(),8);await migrate(db);
    kv=createKeyValue(redisUrl);await kv.connect();
  });
  beforeEach(async()=>{await db.pool.query('DELETE FROM incidents');await db.pool.query('DELETE FROM service_epochs');});
  afterEach(async()=>{vi.restoreAllMocks();for(const health of services.splice(0))await health.stop();});
  afterAll(async()=>{if(kv?.isOpen)await kv.quit();if(db)await db.pool.end();if(admin){await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.pool.end();}});
  async function startHealth():Promise<Health>{
    const health=new Health(db,kv,'api');services.push(health);await health.start();
    // The suite drives checkpoints explicitly to make each concurrency scenario repeatable.
    const timer=Reflect.get(health,'timer') as NodeJS.Timeout|undefined;if(timer)clearInterval(timer);
    return health;
  }
  async function now():Promise<number>{return transaction(db,databaseNow);}
  async function epoch(checkpoint:number,status='active'):Promise<string>{const id=randomUUID();await db.pool.query('INSERT INTO service_epochs(id,kind,last_healthy,status,started_at) VALUES($1,\'api\',$2,$3,$2)',[id,checkpoint,status]);return id;}
  async function incident(epochId:string,startedAt:number,recoveredAt:number|null=null):Promise<string>{const id=randomUUID();await db.pool.query('INSERT INTO incidents(id,epoch_id,reason,started_at,recovered_at) VALUES($1,$2,\'infrastructure\',$3,$4)',[id,epochId,startedAt,recoveredAt]);return id;}
  function stateAt(time:number):EngineState{
    const words=['CROSSWORD','WORDGAMES'],lexicon={has:(word:string)=>words.includes(word)};
    let state=createGame({id:randomUUID(),players:[{id:randomUUID(),username:'One'},{id:randomUUID(),username:'Two'}],minutes:5,lexiconVersion:'test',seedWords:words,now:time-10000,randomInt:()=>0,firstSeat:0},lexicon);
    state=setConnected(state,0,true,time-9000);state=setConnected(state,1,true,time-9000);state=startIfReady(state,time-6000);
    state.lastTransitionAt=time-1000;return state;
  }
  function reader():Health{return new Health(db,kv,'worker');}

  it('does not trust a checkpoint whose COMMIT failed',async()=>{
    const health=await startHealth();expect(health.ready).toBe(true);
    const before=Number((await db.pool.query<{last_healthy:string}>('SELECT last_healthy FROM service_epochs WHERE id=$1',[health.epoch])).rows[0]!.last_healthy);
    await db.pool.query('SELECT pg_sleep(0.005)');
    const realConnect=db.pool.connect.bind(db.pool);
    const replacement=vi.spyOn(db.pool,'connect').mockImplementationOnce(async()=>{
      const client=await realConnect();
      return {query:async(text:string,values?:unknown[])=>{if(text==='COMMIT')throw new Error('Injected COMMIT transport failure');return client.query(text,values);},release:()=>client.release()} as PoolClient;
    });
    await health.tick();replacement.mockRestore();expect(health.ready).toBe(false);
    expect(Number((await db.pool.query<{last_healthy:string}>('SELECT last_healthy FROM service_epochs WHERE id=$1',[health.epoch])).rows[0]!.last_healthy)).toBe(before);
    await health.tick();expect(health.ready).toBe(true);
    const outage=await db.pool.query<{started_at:string}>('SELECT started_at FROM incidents WHERE epoch_id=$1 AND reason=\'infrastructure\'',[health.epoch]);
    expect(outage.rows).toHaveLength(1);expect(Number(outage.rows[0]!.started_at)).toBe(before);
  });
  it('serializes concurrent stale-epoch reconciliation and returning checkpoints without deadlock',async()=>{
    const health=await startHealth();
    for(let run=0;run<20;run++){
      const at=await now();await db.pool.query('UPDATE service_epochs SET last_healthy=$2,status=\'active\' WHERE id=$1',[health.epoch,at-5000-run]);
      await Promise.all([health.tick(),transaction(db,async c=>health.reconcile(c,await databaseNow(c)))]);
      const row=(await db.pool.query<{status:string}>('SELECT status FROM service_epochs WHERE id=$1',[health.epoch])).rows[0]!;
      expect(row.status).toBe('active');expect(health.ready).toBe(true);
    }
    expect(Number((await db.pool.query<{count:string}>('SELECT count(*) FROM incidents')).rows[0]!.count)).toBeGreaterThan(0);
  });
  it('cannot restore active readiness after draining starts during an in-flight checkpoint',async()=>{
    const health=await startHealth();
    const trusted=Number((await db.pool.query<{last_healthy:string}>('SELECT last_healthy FROM service_epochs WHERE id=$1',[health.epoch])).rows[0]!.last_healthy);
    const checkpoint=health.tick(),draining=health.stop();await Promise.all([checkpoint,draining]);
    expect(health.ready).toBe(false);
    expect((await db.pool.query<{status:string}>('SELECT status FROM service_epochs WHERE id=$1',[health.epoch])).rows[0]!.status).toBe('draining');
    await health.tick();expect(health.ready).toBe(false);
    expect((await db.pool.query<{status:string}>('SELECT status FROM service_epochs WHERE id=$1',[health.epoch])).rows[0]!.status).toBe('draining');
    await Promise.all([health.stop(),health.stop()]);
    expect(Number((await db.pool.query<{count:string}>('SELECT count(*) FROM incidents WHERE epoch_id=$1 AND reason=\'deployment\'',[health.epoch])).rows[0]!.count)).toBe(1);
    expect(Number((await db.pool.query<{started_at:string}>('SELECT started_at FROM incidents WHERE epoch_id=$1 AND reason=\'deployment\'',[health.epoch])).rows[0]!.started_at)).toBe(trusted);
  });
  it('clamps a concurrently observed future incident to the captured transition time',async()=>{
    const time=await now(),state=stateAt(time),id=await epoch(time+10),outage=await incident(id,time+5,time+9);
    const evidence=await transaction(db,c=>reader().evidence(c,state,[[id],[id]],time,null));
    expect(evidence.pauseAt).toBe(time);expect(evidence.incidentIds).toEqual([outage]);
  });
  it('still handles an unobserved outage when a later transition advanced the saved timestamp',async()=>{
    const time=await now(),state=stateAt(time),id=await epoch(time);await incident(id,time-5000,time-3000);
    const evidence=await transaction(db,c=>reader().evidence(c,state,[[id],[id]],time,null));
    expect(evidence.pauseAt).toBe(state.lastTransitionAt);
  });
  it('ignores an outage that had already recovered before the game existed',async()=>{
    const time=await now(),state=stateAt(time),id=await epoch(time);await incident(id,state.createdAt-1000,state.createdAt-1);
    const evidence=await transaction(db,c=>reader().evidence(c,state,[[id],[id]],time,null));
    expect(evidence.pauseAt).toBeNull();expect(evidence.incidentIds).toEqual([]);
  });
  it('a still-healthy game tab prevents an unrelated gateway outage from pausing that player',async()=>{
    const time=await now(),state=stateAt(time),lost=await epoch(time-5000,'lost'),live=await epoch(time),outage=await incident(lost,time-4000);
    const evidence=await transaction(db,c=>reader().evidence(c,state,[[lost,live],[live]],time,null));
    expect(evidence.pauseAt).toBeNull();expect(evidence.healthy).toBe(true);expect(evidence.incidentIds).toEqual([outage]);
  });
  it('requires a positive checkpoint strictly after the candidate loss deadline',async()=>{
    const time=await now(),state=stateAt(time),deadline=time-1000,id=await epoch(deadline);
    const first=await transaction(db,c=>reader().evidence(c,state,[[id],[id]],time,deadline));expect(first.pending).toBe(true);expect(first.pauseAt).toBeNull();
    await db.pool.query('UPDATE service_epochs SET last_healthy=$2 WHERE id=$1',[id,deadline+1]);
    const second=await transaction(db,c=>reader().evidence(c,state,[[id],[id]],time,deadline));expect(second.pending).toBe(false);
  });
  it('turns a missing checkpoint into a pause after three seconds rather than a player loss',async()=>{
    const time=await now(),state=stateAt(time),id=await epoch(time-3001);
    const evidence=await transaction(db,c=>reader().evidence(c,state,[[id],[id]],time,time-1000));
    expect(evidence.pauseAt).toBe(state.lastTransitionAt);expect(evidence.pending).toBe(true);
  });
  it('does not use a passed player’s lost gateway to pause the remaining player',async()=>{
    const time=await now(),state=stateAt(time);state.players[0].passed=true;state.activeSeat=1;
    const lost=await epoch(time-5000,'lost'),live=await epoch(time);await incident(lost,time-4000);
    const evidence=await transaction(db,c=>reader().evidence(c,state,[[lost],[live]],time,null));expect(evidence.pauseAt).toBeNull();
  });
  it('does not finalize a loss in an active game whose responsible gateway metadata is missing',async()=>{
    const time=await now(),state=stateAt(time),id=await epoch(time);
    const evidence=await transaction(db,c=>reader().evidence(c,state,[[],[id]],time,time-1000));expect(evidence.pauseAt).toBe(state.lastTransitionAt);expect(evidence.pending).toBe(true);
  });
});
