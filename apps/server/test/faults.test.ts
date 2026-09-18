import { randomBytes,randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { io as connectSocket,type Socket } from 'socket.io-client';
import type { CommandReply,GameCommand,GameView,Seat,User } from '@bestword/contracts';
import { assertStateInvariants,type EngineState } from '@bestword/engine';
import { FaultProxy } from '../../../tools/testing/fault-proxy.js';
import { buildApp } from '../src/app.js';
import { digestToken } from '../src/auth.js';
import { readConfig,type Config } from '../src/config.js';
import { createDatabase,databaseNow,migrate,transaction,type Database } from '../src/db.js';

const enabled=process.env['BESTWORD_INTEGRATION']==='1';
const sourceDatabase=process.env['BESTWORD_TEST_DATABASE_URL']??process.env['DATABASE_URL'];
const sourceRedis=process.env['BESTWORD_TEST_REDIS_URL']??process.env['REDIS_URL'];
type Application=Awaited<ReturnType<typeof buildApp>>;
interface Running {application:Application;url:string;config:Config;closed:boolean}
interface Participant {user:User;token:string;socket:Socket}
interface Table {id:string;players:[Participant,Participant]}

describe.skipIf(!enabled)('real dependency faults and durable game recovery',()=>{
  let admin:Database,observer:Database,databaseUrl:string,schema:string;
  const running:Running[]=[],proxies:FaultProxy[]=[],sockets:Socket[]=[];
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
  async function openSocket(instance:Running,token?:string):Promise<Socket>{
    const socket=connectSocket(instance.url,{transports:['websocket'],forceNew:true,reconnection:false,timeout:5000,extraHeaders:token?{cookie:`bw_session=${token}`}:{}});sockets.push(socket);
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;
  }
  async function request(socket:Socket,event:'game:subscribe'|'game:sync'|'game:command',payload:unknown):Promise<CommandReply>{return socket.timeout(7000).emitWithAck(event,payload) as Promise<CommandReply>;}
  async function table(instance:Running):Promise<Table>{
    const people:[{user:User;token:string},{user:User;token:string}]=[0,1].map(()=>({user:{id:randomUUID(),username:`F${randomBytes(5).toString('hex')}`},token:randomBytes(32).toString('hex')})) as [{user:User;token:string},{user:User;token:string}];
    const now=await transaction(observer,databaseNow);
    for(const {user,token}of people){await observer.pool.query('INSERT INTO users(id,username,username_key,password_hash,created_at) VALUES($1,$2,$3,\'fixture-not-used-for-login\',$4)',[user.id,user.username,user.username.toLowerCase(),now]);await observer.pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[digestToken(token),user.id,now+300000]);}
    const seek=randomUUID();await observer.pool.query('INSERT INTO seeks(id,user_id,minutes,created_at,expires_at) VALUES($1,$2,5,$3,$4)',[seek,people[0].user.id,now,now+60000]);
    const id=await instance.application.games.join(seek,people[1].user);
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

  it('a deleted session receives no private publication even if its revocation notification was lost',async()=>{
    const instance=await launch(),game=await table(instance),before=await state(game.id),revokedSeat:Seat=before.activeSeat===0?1:0;
    const revoked=game.players[revokedSeat],privateUpdates:GameView[]=[],publicUpdates:GameView[]=[];
    const spectator=await openSocket(instance);expect((await request(spectator,'game:subscribe',{gameId:game.id})).ok).toBe(true);
    revoked.socket.on('game:update',(view:GameView)=>privateUpdates.push(view));spectator.on('game:update',(view:GameView)=>publicUpdates.push(view));
    await observer.pool.query('DELETE FROM sessions WHERE token_hash=$1',[digestToken(revoked.token)]);
    await acceptedNoWords(game);await eventually(async()=>publicUpdates,updates=>updates.some(view=>view.game.moves.length===1),'spectator publication');
    // Ignore setup packets already in flight before deletion; the new move was
    // committed only after revocation, so none of its private views may arrive.
    await delay(100);expect(privateUpdates.filter(view=>view.game.moves.length>=1&&view.you!==null)).toEqual([]);expect(publicUpdates.every(view=>view.you===null)).toBe(true);
    // Reauthenticate a same-game sync: the old player room must become a public spectator room.
    if(revoked.socket.connected){const sync=await request(revoked.socket,'game:sync',{gameId:game.id});expect(sync.ok).toBe(true);if(sync.ok)expect(sync.view.you).toBeNull();}
  },15000);
});
