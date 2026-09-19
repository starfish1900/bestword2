import { randomBytes,randomUUID } from 'node:crypto';
import { spawn,type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { io as connectSocket,type Socket } from 'socket.io-client';
import { INCREMENT_MS,type CommandReply,type GameCommand,type GameView,type Seat,type User } from '@bestword/contracts';
import { assertStateInvariants,type EngineState } from '@bestword/engine';
import { FaultProxy } from '../../../tools/testing/fault-proxy.js';
import { buildApp } from '../src/app.js';
import { digestToken } from '../src/auth.js';
import { readConfig,type Config } from '../src/config.js';
import { createDatabase,databaseNow,migrate,transaction,type Database } from '../src/db.js';
import { createKeyValue,KEY_VALUE_REPLY_TIMEOUT_MS } from '../src/kv.js';
import { Games } from '../src/games.js';

const enabled=process.env['BESTWORD_INTEGRATION']==='1';
const sourceDatabase=process.env['BESTWORD_TEST_DATABASE_URL']??process.env['DATABASE_URL'];
const sourceRedis=process.env['BESTWORD_TEST_REDIS_URL']??process.env['REDIS_URL'];
type Application=Awaited<ReturnType<typeof buildApp>>;
interface Running {application:Application;url:string;config:Config;closed:boolean}
interface Participant {user:User;token:string;socket:Socket}
interface Table {id:string;players:[Participant,Participant]}

describe.skipIf(!enabled)('real dependency faults and durable game recovery',()=>{
  let admin:Database,observer:Database,databaseUrl:string,schema:string;
  const running:Running[]=[],proxies:FaultProxy[]=[],sockets:Socket[]=[],children:ChildProcess[]=[];
  beforeAll(async()=>{if(!sourceDatabase||!sourceRedis)throw new Error('Fault tests require DATABASE_URL and REDIS_URL.');admin=createDatabase(sourceDatabase,2);});
  beforeEach(async()=>{
    schema=`faults_${randomUUID().replaceAll('-','')}`;await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(sourceDatabase!);url.searchParams.set('options',`-c search_path=${schema}`);databaseUrl=url.toString();
    observer=createDatabase(databaseUrl,4);await migrate(observer);
  });
  afterEach(async()=>{
    for(const proxy of proxies)proxy.recover();
    for(const socket of sockets.splice(0))socket.disconnect();
    for(const instance of running.splice(0))if(!instance.closed){await instance.application.close();instance.closed=true;}
    for(const child of children.splice(0))await killChild(child);
    for(const proxy of proxies.splice(0))await proxy.close();
    if(observer)await observer.pool.end();if(schema)await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
  afterAll(async()=>{if(admin)await admin.pool.end();});

  async function eventually<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,description:string,timeout=12000):Promise<T>{
    const deadline=Date.now()+timeout;let last:T|undefined,lastError:unknown;
    while(Date.now()<deadline){try{last=await read();if(accept(last))return last;}catch(error){lastError=error;}await delay(30);}
    throw new Error(`Timed out: ${description}. Last value: ${JSON.stringify(last)}. Error: ${String(lastError??'none')}`);
  }
  async function state(id:string):Promise<EngineState>{const row=await observer.pool.query<{state:EngineState}>('SELECT state FROM games WHERE id=$1',[id]);if(!row.rows[0])throw new Error('Game missing');return row.rows[0].state;}
  async function proxyFor(source:string,defaultPort:number):Promise<FaultProxy>{const url=new URL(source),proxy=await new FaultProxy(url.hostname,Number(url.port)||defaultPort).start();proxies.push(proxy);return proxy;}
  async function launch(dbUrl=databaseUrl,redisUrl=sourceRedis!,savedConfig?:Config):Promise<Running>{
    const config=savedConfig??readConfig({NODE_ENV:'test',DATABASE_URL:dbUrl,REDIS_URL:redisUrl,APP_ORIGIN:'http://127.0.0.1',HOST:'127.0.0.1',PORT:'3001',LOG_LEVEL:'silent',DB_POOL_SIZE:'8',WORKER_INTERVAL_MS:'50',LEXICON_PATH:resolve('data/lexicon.bin.gz')});
    const application=await buildApp(config),url=await application.app.listen({port:0,host:'127.0.0.1'});
    const instance={application,url,config,closed:false};running.push(instance);return instance;
  }
  async function killChild(child:ChildProcess):Promise<void>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    await new Promise<void>((resolve,reject)=>{child.once('exit',()=>resolve());if(!child.kill('SIGKILL'))reject(new Error('Could not terminate the test-owned API process'));});
  }
  async function launchChild():Promise<{url:string;child:ChildProcess}>{
    const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
    const address=reservation.address();if(!address||typeof address==='string')throw new Error('Port reservation failed');
    const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
    const child=spawn(process.execPath,['--import','tsx','apps/server/src/index.ts'],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',DATABASE_URL:databaseUrl,REDIS_URL:sourceRedis!,PORT:String(port),HOST:'127.0.0.1',APP_ORIGIN:`http://127.0.0.1:${port}`,DB_POOL_SIZE:'8',WORKER_INTERVAL_MS:'50',LEXICON_PATH:resolve('data/lexicon.bin.gz'),LOG_LEVEL:'silent'}});
    children.push(child);let output='';for(const stream of [child.stdout,child.stderr])stream?.on('data',chunk=>{output=(output+String(chunk)).slice(-20000);});
    const url=`http://127.0.0.1:${port}`;
    await eventually(async()=>{if(child.exitCode!==null)throw new Error(`API exited ${child.exitCode}: ${output}`);return (await fetch(`${url}/health/ready`,{signal:AbortSignal.timeout(1000)})).ok;},Boolean,'test-owned child API ready');
    return {url,child};
  }
  async function openSocket(instance:{url:string},token?:string):Promise<Socket>{
    const socket=connectSocket(instance.url,{transports:['websocket'],forceNew:true,reconnection:false,timeout:5000,extraHeaders:token?{cookie:`bw_session=${token}`}:{}});sockets.push(socket);
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;
  }
  async function request(socket:Socket,event:'game:subscribe'|'game:sync'|'game:command',payload:unknown):Promise<CommandReply>{return socket.timeout(7000).emitWithAck(event,payload) as Promise<CommandReply>;}
  async function table(instance:{url:string}):Promise<Table>{
    const people:[{user:User;token:string},{user:User;token:string}]=[0,1].map(()=>({user:{id:randomUUID(),username:`F${randomBytes(5).toString('hex')}`},token:randomBytes(32).toString('hex')})) as [{user:User;token:string},{user:User;token:string}];
    const now=await transaction(observer,databaseNow);
    for(const {user,token}of people){await observer.pool.query('INSERT INTO users(id,username,username_key,password_hash,created_at) VALUES($1,$2,$3,\'fixture-not-used-for-login\',$4)',[user.id,user.username,user.username.toLowerCase(),now]);await observer.pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[digestToken(token),user.id,now+300000]);}
    const seek=randomUUID();await observer.pool.query('INSERT INTO seeks(id,user_id,minutes,created_at,expires_at) VALUES($1,$2,5,$3,$4)',[seek,people[0].user.id,now,now+60000]);
    const joined=await fetch(`${instance.url}/api/seeks/${seek}/join`,{method:'POST',headers:{cookie:`bw_session=${people[1].token}`}});expect(joined.status).toBe(200);
    const {gameId:id}=await joined.json() as {gameId:string};
    const players=[] as Participant[];
    for(const person of people){const socket=await openSocket(instance,person.token);const reply=await request(socket,'game:subscribe',{gameId:id});expect(reply.ok).toBe(true);players.push({...person,socket});}
    await eventually(()=>state(id),value=>value.status==='active'&&value.turnStartedAt!==null,'initial countdown');
    return {id,players:players as [Participant,Participant]};
  }
  async function acceptedNoWords(table:Table,shortNextClock=false):Promise<{command:GameCommand;seat:Seat;saved:EngineState;acceptedRevision:number}>{
    if(shortNextClock)await transaction(observer,async c=>{
      const result=await c.query<{state:EngineState}>('SELECT state FROM games WHERE id=$1 FOR UPDATE',[table.id]);const current=result.rows[0]!.state;
      // Clock fixture is installed before the acknowledged action that starts this turn.
      current.clocksMs[current.activeSeat===0?1:0]=1500;
      await c.query('UPDATE games SET state=$2 WHERE id=$1',[table.id,JSON.stringify(current)]);
    });
    const before=await state(table.id),seat=before.activeSeat,command:GameCommand={gameId:table.id,commandId:randomUUID(),expectedRevision:before.revision,action:{type:'NO_WORDS'}};
    const reply=await request(table.players[seat].socket,'game:command',command);expect(reply.ok).toBe(true);if(!reply.ok)throw new Error(reply.error.message);
    const saved=await state(table.id);assertStateInvariants(saved);expect(saved.moves).toHaveLength(1);
    return {command,seat,saved,acceptedRevision:reply.acceptedRevision!};
  }
  function acceptedContent(value:EngineState):unknown{return {board:value.board,players:value.players.map(player=>({id:player.id,score:player.score,rack:player.rack,passed:player.passed})),bag:value.bag,drawOrder:value.consonantDrawOrder,drawnThisTurn:value.drawnThisTurn,history:value.principalHistory,moves:value.moves};}

  it('an injected lost COMMIT acknowledgement resolves the actual PostgreSQL receipt on identical retry without a second move, draw or increment',async()=>{
    const instance=await launch(),game=await table(instance),before=await state(game.id),seat=before.activeSeat;
    const command:GameCommand={gameId:game.id,commandId:randomUUID(),expectedRevision:before.revision,action:{type:'NO_WORDS'}};
    const service=instance.application.games,normalCommand=service.command.bind(service),commandDb=createDatabase(databaseUrl,1);
    let injected=0;
    // Deterministic acknowledgement-loss injection, NOT a real network fault:
    // only this command uses this separate pool. The PostgreSQL COMMIT really
    // completes before its response is hidden from the command service.
    const injectedPool=new Proxy(commandDb.pool,{get(target,key){
      if(key==='connect')return async()=>{
        const client=await target.connect();let selectedGame=false;
        return new Proxy(client,{get(connection,property){
          const value=Reflect.get(connection,property,connection) as unknown;
          if(property==='query')return async(...args:unknown[])=>{
            const result=await Reflect.apply(connection.query,connection,args);
            if(args[0]==='SELECT * FROM games WHERE id=$1 FOR UPDATE'&&Array.isArray(args[1])&&args[1][0]===game.id)selectedGame=true;
            if(args[0]==='COMMIT'&&selectedGame&&injected===0){injected++;throw new Error('Connection terminated unexpectedly: injected acknowledgement loss after real COMMIT');}
            return result;
          };
          return typeof value==='function'?value.bind(connection):value;
        }});
      };
      const value=Reflect.get(target,key,target) as unknown;return typeof value==='function'?value.bind(target):value;
    }});
    const isolated=new Games({...commandDb,pool:injectedPool},service.kv,service.health,service.lexicon,service.config);
    service.command=(input,user)=>input.commandId===command.commandId&&injected===0?isolated.command(input,user):normalCommand(input,user);
    try{
      const uncertain=await request(game.players[seat].socket,'game:command',command);
      expect(injected).toBe(1);expect(uncertain.ok).toBe(false);expect('acceptedRevision'in uncertain).toBe(false);
      if(!uncertain.ok)expect(uncertain.error.code).toBe('SERVICE_RECOVERING');
      const committed=await state(game.id);assertStateInvariants(committed);expect(committed.moves).toHaveLength(1);
      expect(committed.moves[0]!.action).toBe('NO_WORDS');expect(committed.revision).toBe(before.revision+1);
      const nextSeat:Seat=seat===0?1:0;
      expect(committed.players[nextSeat].rack).toHaveLength(before.players[nextSeat].rack.length+2);
      expect(committed.consonantDrawOrder).toEqual(before.consonantDrawOrder.slice(0,-2));
      expect(committed.clocksMs[seat]).toBe(before.clocksMs[seat]-(committed.moves[0]!.at-before.turnStartedAt!)+INCREMENT_MS);
      const duplicate=await request(game.players[seat].socket,'game:command',command);
      expect(duplicate.ok).toBe(true);if(duplicate.ok)expect(duplicate.acceptedRevision).toBe(committed.revision);
      const restored=await state(game.id);expect(restored.revision).toBe(committed.revision);expect(restored.clocksMs).toEqual(committed.clocksMs);expect(restored.turnStartedAt).toBe(committed.turnStartedAt);
      expect(acceptedContent(restored)).toEqual(acceptedContent(committed));assertStateInvariants(restored);
      const receipt=await observer.pool.query<{reply:{ok:boolean;revision:number}}>('SELECT reply FROM commands WHERE game_id=$1 AND command_id=$2',[game.id,command.commandId]);
      expect(receipt.rows).toEqual([{reply:{ok:true,revision:committed.revision}}]);
      expect((await observer.pool.query('SELECT 1 FROM game_events WHERE game_id=$1 AND kind=\'action\'',[game.id])).rowCount).toBe(1);
    }finally{service.command=normalCommand;await commandDb.pool.end();}
  },15000);

  for(const dependency of ['Redis','PostgreSQL'] as const)it(`${dependency} network loss near zero preserves the acknowledged move, pauses and resumes without redrawing`,async()=>{
    const proxy=await proxyFor(dependency==='Redis'?sourceRedis!:databaseUrl,dependency==='Redis'?6379:5432);
    const instance=await launch(dependency==='PostgreSQL'?proxy.url(databaseUrl):databaseUrl,dependency==='Redis'?proxy.url(sourceRedis!):sourceRedis!);
    const game=await table(instance),accepted=await acceptedNoWords(game,true);const original=acceptedContent(accepted.saved);
    proxy.cut();
    await delay(4200); // Deliberately exceeds both the1.5s clock and3s outage-confirmation interval.
    const during=await state(game.id);expect(during.result).toBeNull();expect(acceptedContent(during)).toEqual(original);
    proxy.recover();
    const countdown=await eventually(()=>state(game.id),value=>value.status==='active'&&value.startsAt!==null,'recovery countdown');
    expect(countdown.result).toBeNull();expect(countdown.clocksMs[countdown.activeSeat]).toBeGreaterThan(500);expect(acceptedContent(countdown)).toEqual(original);assertStateInvariants(countdown);
    const resumed=await eventually(()=>state(game.id),value=>value.status==='active'&&value.turnStartedAt!==null&&value.startsAt===null,'resumed active turn');
    expect(resumed.result).toBeNull();expect(acceptedContent(resumed)).toEqual(original);assertStateInvariants(resumed);
    const finish:GameCommand={gameId:game.id,commandId:randomUUID(),expectedRevision:resumed.revision,action:{type:'PASS'}};
    const reply=await request(game.players[resumed.activeSeat].socket,'game:command',finish);expect(reply.ok).toBe(true);
    const receipts=await observer.pool.query<{reply:{ok:boolean;revision:number}}>('SELECT reply FROM commands WHERE game_id=$1 AND command_id=$2',[game.id,accepted.command.commandId]);
    expect(receipts.rows[0]?.reply).toEqual({ok:true,revision:accepted.acceptedRevision});
  },25000);

  it('a half-open Redis connection rejects commands promptly, releases the game lock and protects a near-zero clock',async()=>{
    const proxy=await proxyFor(sourceRedis!,6379),instance=await launch(databaseUrl,proxy.url(sourceRedis!));
    const game=await table(instance),accepted=await acceptedNoWords(game,true),original=acceptedContent(accepted.saved);
    const attempted:GameCommand={gameId:game.id,commandId:randomUUID(),expectedRevision:accepted.saved.revision,action:{type:'PASS'}};
    proxy.blackhole();const interruptedAt=Date.now();
    const reply=await request(game.players[accepted.saved.activeSeat].socket,'game:command',attempted);
    expect(reply.ok).toBe(false);if(!reply.ok)expect(reply.error.code).toBe('SERVICE_RECOVERING');
    expect(Date.now()-interruptedAt).toBeLessThan(KEY_VALUE_REPLY_TIMEOUT_MS+1500);
    // A separate PostgreSQL connection must acquire the row after the rejected
    // command. The check cannot succeed while an unanswered Redis call holds it.
    await eventually(()=>transaction(observer,async c=>{await c.query('SELECT id FROM games WHERE id=$1 FOR UPDATE NOWAIT',[game.id]);return true;}),Boolean,'command released its PostgreSQL row lock',1000);
    await delay(Math.max(0,4200-(Date.now()-interruptedAt)));
    const during=await state(game.id);expect(during.result).toBeNull();expect(acceptedContent(during)).toEqual(original);
    const receipts=await observer.pool.query('SELECT 1 FROM commands WHERE game_id=$1 AND command_id=$2',[game.id,attempted.commandId]);expect(receipts.rowCount).toBe(0);
    proxy.recover();
    const countdown=await eventually(()=>state(game.id),value=>value.status==='active'&&value.startsAt!==null,'half-open recovery countdown');
    expect(countdown.clocksMs[countdown.activeSeat]).toBeGreaterThan(500);expect(acceptedContent(countdown)).toEqual(original);
    const resumed=await eventually(()=>state(game.id),value=>value.status==='active'&&value.turnStartedAt!==null&&value.startsAt===null,'half-open recovery active turn');
    expect(resumed.result).toBeNull();expect(acceptedContent(resumed)).toEqual(original);assertStateInvariants(resumed);
    expect((await request(game.players[resumed.activeSeat].socket,'game:command',{...attempted,expectedRevision:resumed.revision})).ok).toBe(true);
  },25000);

  it('a half-open Redis connection bounds both a command and a chained MULTI batch, then reconnects',async()=>{
    const proxy=await proxyFor(sourceRedis!,6379),kv=createKeyValue(proxy.url(sourceRedis!)),key=`bw:fault:${randomUUID()}`;
    try{
      await kv.connect();await kv.ping();proxy.blackhole();const started=Date.now();
      const outcomes=await Promise.allSettled([kv.ping(),kv.multi().set(key,'fixture',{PX:10000}).get(key).exec()]);
      expect(outcomes.every(outcome=>outcome.status==='rejected')).toBe(true);expect(Date.now()-started).toBeLessThan(KEY_VALUE_REPLY_TIMEOUT_MS+1000);
      proxy.recover();await eventually(async()=>kv.isReady&&await kv.ping()==='PONG',Boolean,'command client reconnects');
    }finally{proxy.recover();if(kv.isReady)await kv.del(key);if(kv.isOpen)kv.destroy();}
  },12000);

  it('an oversized MULTI batch cannot leave the shared command connection inside a transaction',async()=>{
    const kv=createKeyValue(sourceRedis!);
    try{
      await kv.connect();const batch=kv.multi();
      for(let index=0;index<(kv.options?.commandsQueueMaxLength??10000)+2;index++)batch.ping();
      await expect(batch.exec()).rejects.toThrow();
      await eventually(async()=>kv.isReady&&await kv.ping()==='PONG',Boolean,'connection recovers from partial MULTI enqueue');
      // A poisoned connection responds QUEUED instead of the actual command result.
      expect(await kv.eval('return {ARGV[1]}',{arguments:['healthy']})).toEqual(['healthy']);
    }finally{if(kv.isOpen)kv.destroy();}
  },12000);

  it('a PostgreSQL disconnect between transaction queries is handled and the client is discarded',async()=>{
    const proxy=await proxyFor(databaseUrl,5432),db=createDatabase(proxy.url(databaseUrl),1);
    let previousPid=0;
    try{
      await expect(transaction(db,async c=>{
        previousPid=Number((await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        proxy.cut();
        // No query is pending while the TCP socket closes. A checked-out
        // client's error event must not escape as an uncaught exception.
        await delay(100);
        await c.query('SELECT 1');
      })).rejects.toThrow(/not queryable|terminated|connection/i);
      expect(db.pool.totalCount).toBe(0);
      proxy.recover();
      const fresh=await db.pool.query<{pid:number}>('SELECT pg_backend_pid() AS pid');
      expect(fresh.rows[0]!.pid).not.toBe(previousPid);
    }finally{proxy.recover();await db.pool.end();}
  });

  it('a half-open PostgreSQL connection bounds transaction cleanup and retires the uncertain client',async()=>{
    const proxy=await proxyFor(databaseUrl,5432),db=createDatabase(proxy.url(databaseUrl),1);
    let previousPid=0;const started=Date.now();
    try{
      await expect(transaction(db,async c=>{
        previousPid=Number((await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        await c.query('SELECT version FROM schema_migrations FOR UPDATE');
        proxy.blackhole();await c.query('SELECT 1');
      })).rejects.toThrow('Query read timeout');
      expect(Date.now()-started).toBeLessThan(10000);expect(db.pool.totalCount).toBe(0);
      proxy.recover();
      const fresh=await db.pool.query<{pid:number}>('SELECT pg_backend_pid() AS pid');expect(fresh.rows[0]!.pid).not.toBe(previousPid);
      // The old server transaction must no longer retain its row lock.
      await transaction(observer,async c=>{await c.query('SELECT version FROM schema_migrations FOR UPDATE NOWAIT');});
    }finally{proxy.recover();await db.pool.end();}
  },15000);

  it('an unanswered PostgreSQL ROLLBACK preserves the original error and discards its transaction client',async()=>{
    const proxy=await proxyFor(databaseUrl,5432),db=createDatabase(proxy.url(databaseUrl),1),failure=new Error('Application rejected the transaction');
    try{
      const started=Date.now();
      await expect(transaction(db,async c=>{await c.query('SELECT version FROM schema_migrations FOR UPDATE');proxy.blackhole();throw failure;})).rejects.toBe(failure);
      expect(Date.now()-started).toBeLessThan(10000);expect(db.pool.totalCount).toBe(0);
      proxy.recover();
      await transaction(db,async c=>{await c.query('SELECT version FROM schema_migrations FOR UPDATE NOWAIT');});
    }finally{proxy.recover();await db.pool.end();}
  },15000);

  it('a PostgreSQL traffic blackhole longer than the read deadline preserves the accepted game and resumes its near-zero clock',async()=>{
    const proxy=await proxyFor(databaseUrl,5432),instance=await launch(proxy.url(databaseUrl));
    const game=await table(instance),accepted=await acceptedNoWords(game,true),original=acceptedContent(accepted.saved);
    const attempted:GameCommand={gameId:game.id,commandId:randomUUID(),expectedRevision:accepted.saved.revision,action:{type:'PASS'}};
    proxy.blackhole();const interruptedAt=Date.now();
    const reply=await game.players[accepted.saved.activeSeat].socket.timeout(12000).emitWithAck('game:command',attempted) as CommandReply;
    expect(reply.ok).toBe(false);if(!reply.ok)expect(reply.error.code).toBe('SERVICE_RECOVERING');
    expect(Date.now()-interruptedAt).toBeLessThan(10000);
    await delay(Math.max(0,9000-(Date.now()-interruptedAt)));
    const during=await state(game.id);expect(during.result).toBeNull();expect(acceptedContent(during)).toEqual(original);
    expect((await observer.pool.query('SELECT 1 FROM commands WHERE game_id=$1 AND command_id=$2',[game.id,attempted.commandId])).rowCount).toBe(0);
    proxy.recover();
    const countdown=await eventually(()=>state(game.id),value=>value.status==='active'&&value.startsAt!==null,'PostgreSQL blackhole recovery countdown',20000);
    expect(countdown.clocksMs[countdown.activeSeat]).toBeGreaterThan(500);expect(acceptedContent(countdown)).toEqual(original);
    const resumed=await eventually(()=>state(game.id),value=>value.status==='active'&&value.turnStartedAt!==null&&value.startsAt===null,'PostgreSQL blackhole resumed turn');
    expect(resumed.result).toBeNull();expect(acceptedContent(resumed)).toEqual(original);assertStateInvariants(resumed);
    expect((await request(game.players[resumed.activeSeat].socket,'game:command',{...attempted,expectedRevision:resumed.revision})).ok).toBe(true);
  },40000);

  it('restarting the gateway returns the committed receipt and preserves its draws exactly once',async()=>{
    const first=await launch(),game=await table(first),accepted=await acceptedNoWords(game),original=acceptedContent(accepted.saved);
    const oldEpoch=first.application.health.epoch;await first.application.close();first.closed=true;
    const replacement=await launch(databaseUrl,sourceRedis!,first.config);expect(replacement.application.health.epoch).not.toBe(oldEpoch);
    for(const participant of game.players){participant.socket=await openSocket(replacement,participant.token);const reply=await request(participant.socket,'game:subscribe',{gameId:game.id});expect(reply.ok).toBe(true);}
    const duplicate=await request(game.players[accepted.seat].socket,'game:command',accepted.command);expect(duplicate.ok).toBe(true);
    if(!duplicate.ok)throw new Error(duplicate.error.message);expect(duplicate.acceptedRevision).toBe(accepted.acceptedRevision);
    const restored=await state(game.id);expect(acceptedContent(restored)).toEqual(original);assertStateInvariants(restored);
    const commands=await observer.pool.query<{count:string}>('SELECT count(*) FROM commands WHERE game_id=$1 AND command_id=$2',[game.id,accepted.command.commandId]);expect(Number(commands.rows[0]?.count)).toBe(1);
  },20000);

  it('an abruptly killed API process preserves the last acknowledged receipt and resumes its near-zero game after restart',async()=>{
    const first=await launchChild(),game=await table(first),accepted=await acceptedNoWords(game,true),original=acceptedContent(accepted.saved);
    const previous=await observer.pool.query<{id:string}>('SELECT id FROM service_epochs WHERE kind=\'api\'');expect(previous.rowCount).toBe(1);
    await killChild(first.child);await delay(4200);
    expect((await state(game.id)).result).toBeNull();expect(acceptedContent(await state(game.id))).toEqual(original);
    const replacement=await launchChild();
    for(const participant of game.players){participant.socket=await openSocket(replacement,participant.token);expect((await request(participant.socket,'game:subscribe',{gameId:game.id})).ok).toBe(true);}
    const duplicate=await request(game.players[accepted.seat].socket,'game:command',accepted.command);expect(duplicate.ok).toBe(true);
    if(!duplicate.ok)throw new Error(duplicate.error.message);expect(duplicate.acceptedRevision).toBe(accepted.acceptedRevision);
    const countdown=await eventually(()=>state(game.id),value=>value.status==='active'&&value.startsAt!==null,'crash recovery countdown');
    expect(countdown.clocksMs[countdown.activeSeat]).toBeGreaterThan(500);expect(countdown.result).toBeNull();expect(acceptedContent(countdown)).toEqual(original);
    const resumed=await eventually(()=>state(game.id),value=>value.status==='active'&&value.turnStartedAt!==null&&value.startsAt===null,'crash recovery active turn');
    expect(acceptedContent(resumed)).toEqual(original);assertStateInvariants(resumed);
    expect((await request(game.players[resumed.activeSeat].socket,'game:command',{gameId:game.id,commandId:randomUUID(),expectedRevision:resumed.revision,action:{type:'PASS'}})).ok).toBe(true);
    const receipt=await observer.pool.query('SELECT 1 FROM commands WHERE game_id=$1 AND command_id=$2',[game.id,accepted.command.commandId]);expect(receipt.rowCount).toBe(1);
    const incident=await observer.pool.query('SELECT 1 FROM incidents WHERE epoch_id=$1',[previous.rows[0]!.id]);expect(incident.rowCount).toBeGreaterThan(0);
  },30000);

  it('a deleted session receives no private publication even if its revocation notification was lost',async()=>{
    const instance=await launch(),game=await table(instance),before=await state(game.id),revokedSeat:Seat=before.activeSeat===0?1:0;
    const revoked=game.players[revokedSeat],privateUpdates:GameView[]=[],publicUpdates:GameView[]=[];
    const spectator=await openSocket(instance);expect((await request(spectator,'game:subscribe',{gameId:game.id})).ok).toBe(true);
    revoked.socket.on('game:update',(view:GameView)=>privateUpdates.push(view));spectator.on('game:update',(view:GameView)=>publicUpdates.push(view));
    await observer.pool.query('DELETE FROM sessions WHERE token_hash=$1',[digestToken(revoked.token)]);
    await acceptedNoWords(game);await eventually(async()=>publicUpdates,updates=>updates.some(view=>view.game.moveCount===1),'spectator publication');
    // Ignore setup packets already in flight before deletion; the new move was
    // committed only after revocation, so none of its private views may arrive.
    await delay(100);expect(privateUpdates.filter(view=>view.game.moves.length>=1&&view.you!==null)).toEqual([]);expect(publicUpdates.every(view=>view.you===null&&view.game.moves.length===0&&view.game.historyAccess==='recent')).toBe(true);
    // Reauthenticate a same-game sync: the old player room must become a public spectator room.
    if(revoked.socket.connected){const sync=await request(revoked.socket,'game:sync',{gameId:game.id});expect(sync.ok).toBe(true);if(sync.ok)expect(sync.view.you).toBeNull();}
  },15000);

  it('fresh terminal requests cannot grow receipts and successful receipts remain replayable',async()=>{
    const instance=await launch(),game=await table(instance),accepted=await acceptedNoWords(game);
    for(let index=0;index<2;index++){
      const current=await state(game.id),command:GameCommand={gameId:game.id,commandId:randomUUID(),expectedRevision:current.revision,action:{type:'PASS'}};
      expect((await request(game.players[current.activeSeat].socket,'game:command',command)).ok).toBe(true);
    }
    const terminal=await state(game.id);expect(terminal.status).toBe('finished');
    const count=async()=>Number((await observer.pool.query<{count:string}>('SELECT count(*) AS count FROM commands WHERE game_id=$1',[game.id])).rows[0]!.count);
    const before=await count();expect(before).toBe(3);
    for(let index=0;index<12;index++){
      const reply=await request(game.players[accepted.seat].socket,'game:command',{gameId:game.id,commandId:randomUUID(),expectedRevision:terminal.revision,action:{type:'PASS'}});
      expect(reply.ok).toBe(false);if(!reply.ok)expect(reply.error.code).toBe('GAME_FINISHED');
    }
    const duplicate=await request(game.players[accepted.seat].socket,'game:command',accepted.command);expect(duplicate.ok).toBe(true);
    if(duplicate.ok){expect(duplicate.acceptedRevision).toBe(accepted.acceptedRevision);expect(duplicate.view.game.status).toBe('finished');}
    expect(await count()).toBe(before);expect(acceptedContent(await state(game.id))).toEqual(acceptedContent(terminal));
  },15000);

  it('a command that settles a clock loss persists the outcome without adding a terminal error receipt',async()=>{
    const instance=await launch(),game=await table(instance),accepted=await acceptedNoWords(game);
    await instance.application.health.tick();
    await transaction(observer,async c=>{
      const row=(await c.query<{state:EngineState}>('SELECT state FROM games WHERE id=$1 FOR UPDATE',[game.id])).rows[0]!,current=row.state;
      current.clocksMs[current.activeSeat]=0;current.turnDeadlineAt=current.turnStartedAt;
      // Leave the scheduler's indexed checks in the future so the request must
      // perform the settlement under its own game lock.
      await c.query('UPDATE games SET state=$2,next_check=$3,next_deadline=$3 WHERE id=$1',[game.id,JSON.stringify(current),Date.now()+60000]);
    });
    const command:GameCommand={gameId:game.id,commandId:randomUUID(),expectedRevision:accepted.saved.revision,action:{type:'PASS'}};
    const reply=await request(game.players[accepted.saved.activeSeat].socket,'game:command',command);
    expect(reply.ok).toBe(false);if(!reply.ok)expect(reply.error.code).toBe('GAME_FINISHED');
    const finished=await state(game.id);expect(finished.status).toBe('finished');expect(finished.result?.reason).toBe('clock');expect(finished.revision).toBeGreaterThan(accepted.saved.revision);
    expect((await observer.pool.query('SELECT 1 FROM game_events WHERE game_id=$1 AND revision=$2',[game.id,finished.revision])).rowCount).toBe(1);
    expect((await observer.pool.query('SELECT 1 FROM commands WHERE game_id=$1 AND command_id=$2',[game.id,command.commandId])).rowCount).toBe(0);
    const duplicate=await request(game.players[accepted.seat].socket,'game:command',accepted.command);expect(duplicate.ok).toBe(true);if(duplicate.ok)expect(duplicate.acceptedRevision).toBe(accepted.acceptedRevision);
  },15000);
});
