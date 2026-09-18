import { Server,type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { gameCommandSchema,type CommandReply,type SyncReply,type GameView,type User,type Seat } from '@bestword/contracts';
import { EngineError,projectGame,type EngineState } from '@bestword/engine';
import type { Config } from './config.js';
import { Auth,SESSION_COOKIE,digestToken } from './auth.js';
import { Games } from './games.js';
import { HttpError } from './errors.js';
import { type KeyValue,rateLimit,touchPresence } from './kv.js';

type Ack=(reply:CommandReply)=>void;
type SyncAck=(reply:SyncReply)=>void;
interface Incoming {
  'lobby:subscribe':(ack:(reply:{ok:true})=>void)=>void;
  'game:subscribe':(payload:unknown,ack:Ack)=>void;
  'game:sync':(payload:unknown,ack:SyncAck)=>void;
  'game:command':(payload:unknown,ack:Ack)=>void;
}
interface Outgoing {'game:update':(view:GameView)=>void;'game:matched':(payload:{gameId:string})=>void;'lobby:changed':()=>void;'server:reconnecting':()=>void}
interface SocketData {token:string|undefined;user:User|null;expiresAt:number;game:{id:string;seat:Seat|null;member:string;room:string}|null}
export type GameIO=Server<Incoming,Outgoing,Record<string,never>,SocketData>;
type GameSocket=Socket<Incoming,Outgoing,Record<string,never>,SocketData>;
const subscribeSchema=z.object({gameId:z.uuid()}).strict();
const syncSchema=z.object({gameId:z.uuid(),revision:z.number().int().nonnegative().optional()}).strict();
const SPECTATOR_ADD="redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if not redis.call('ZSCORE',KEYS[1],ARGV[2]) and redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[3]) then return 0 end; redis.call('ZADD',KEYS[1],ARGV[4],ARGV[2]);redis.call('PEXPIRE',KEYS[1],45000);return 1";
const GAME_STREAM='bw:game-updates';
function streamReader(kv:KeyValue):KeyValue{
  const reader=kv.duplicate({disableOfflineQueue:false,commandsQueueMaxLength:100,commandOptions:{timeout:10000},socket:{...kv.options?.socket,socketTimeout:10000}});
  reader.on('error',()=>{});reader.disconnect=async()=>{if(reader.isOpen)reader.destroy();};return reader;
}
function sharedAdapter(kv:KeyValue){
  const readers=new Set<KeyValue>();
  // The adapter immediately retries a failed XREAD. Its blocking read clients
  // must wait through reconnects; inheriting our fail-fast command setting would
  // produce a microtask spin that prevents reconnect timers from running.
  const transport=new Proxy(kv,{get(target,key){
    if(key==='duplicate')return ()=>{
      const reader=streamReader(target);
      readers.add(reader);return reader;
    };
    const value=Reflect.get(target,key,target) as unknown;return typeof value==='function'?value.bind(target):value;
  }});
  const factory=createAdapter(transport,{streamName:'bw:socket-stream',maxLen:10000});
  return function(...args:Parameters<typeof factory>){
    const adapter=factory(...args);
    const close=adapter.close.bind(adapter);
    adapter.close=()=>{close();for(const reader of readers)if(reader.isOpen)reader.destroy();};
    return adapter;
  };
}
export function commandError(error:unknown):CommandReply {
  if(error instanceof HttpError||error instanceof EngineError)return {ok:false,error:{code:error.code,message:error.message}};
  if(error instanceof z.ZodError)return {ok:false,error:{code:'INVALID_REQUEST',message:'The request is not valid.'}};
  return {ok:false,error:{code:'SERVICE_RECOVERING',message:'The service is reconnecting. Your accepted moves are saved.'}};
}
function safeAck(ack:Ack|undefined,reply:CommandReply):void{if(typeof ack==='function')ack(reply);}
export async function publishGame(_io:GameIO,games:Games,state:EngineState):Promise<void>{
  if(!games.kv.isReady)throw new Error('Broadcast unavailable');
  // Await the actual durable stream write before retiring the PostgreSQL outbox.
  // Keep snapshots and private racks out of Redis transport history entirely.
  await games.kv.xAdd(GAME_STREAM,'*',{gameId:state.id,revision:String(state.revision),finished:state.status==='finished'?'1':'0'},{TRIM:{strategy:'MAXLEN',strategyModifier:'~',threshold:10000}});
}
async function deliverLocal(io:GameIO,games:Games,state:EngineState):Promise<void>{
  const spectators=await games.spectators(state.id);
  const time=await games.db.pool.query<{now:string}>('SELECT (extract(epoch from clock_timestamp())*1000)::bigint AS now');const now=Number(time.rows[0]!.now);
  // Session-specific rooms make a lost cross-gateway logout notification safe:
  // revoked sessions are excluded before every private publication.
  const sessions=await games.db.pool.query<{token_hash:string;user_id:string}>('SELECT token_hash,user_id FROM sessions WHERE user_id=ANY($1::uuid[]) AND expires_at>$2',[state.players.map(player=>player.id),now]);
  for(const seat of [0,1] as const){
    const rooms=sessions.rows.filter(session=>session.user_id===state.players[seat].id).map(session=>`game:${state.id}:player:${seat}:session:${session.token_hash}`);
    if(rooms.length)io.local.to(rooms).emit('game:update',projectGame(state,seat,now,spectators));
  }
  io.local.to(`game:${state.id}:spectators`).emit('game:update',projectGame(state,null,now,spectators));
}
export function createPublisher(_kv:KeyValue):GameIO{return new Server<Incoming,Outgoing,Record<string,never>,SocketData>();}
export function attachRealtime(app:FastifyInstance,auth:Auth,games:Games,config:Config):{io:GameIO;stop:()=>Promise<void>} {
  const allowedOrigin=new URL(config.APP_ORIGIN).origin;
  const io:GameIO=new Server(app.server,{transports:['websocket'],pingInterval:5000,pingTimeout:10000,maxHttpBufferSize:16384,serveClient:false,adapter:sharedAdapter(games.kv),allowRequest:(request,callback)=>callback(null,!request.headers.origin||request.headers.origin===allowedOrigin)});
  games.publish=state=>publishGame(io,games,state);
  auth.onSessionRevoked=hash=>{io.in(`session:${hash}`).disconnectSockets(true);};
  auth.onUserSessionsRevoked=id=>{io.in(`user:${id}`).disconnectSockets(true);};
  const sockets=new Set<GameSocket>();
  const subscriptionWork=new Map<GameSocket,Promise<void>>();
  let draining=false;
  const delivered=new Map<string,number>();const reader=streamReader(games.kv);
  const consumer=(async()=>{
    await reader.connect();let offset='0-0',lastWarning=0;
    while(!draining){
      try{
        const batches=await reader.xRead([{key:GAME_STREAM,id:offset}],{BLOCK:5000,COUNT:100}) as Array<{name:string;messages:Array<{id:string;message:Record<string,string>}>}>|null;
        const notices=batches?.[0]?.messages;if(!notices?.length)continue;
        const latest=new Map<string,number>();let lobbyChanged=false;
        for(const notice of notices){const id=notice.message.gameId;const revision=Number(notice.message.revision);if(id&&Number.isSafeInteger(revision))latest.set(id,Math.max(latest.get(id)??-1,revision));if(notice.message.finished==='1')lobbyChanged=true;}
        if(lobbyChanged)io.local.to('lobby').emit('lobby:changed');
        const entries=[...latest].filter(([id,revision])=>io.sockets.adapter.rooms.has(`watch:${id}`)&&(delivered.get(id)??-1)<revision);
        // One database fetch per interested gateway/game, not per spectator.
        const queue=[...entries];
        await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{for(let entry=queue.shift();entry;entry=queue.shift()){
          const state=(await games.read(entry[0])).state;await deliverLocal(io,games,state);
          // The last watcher may have left during either awaited operation.
          if(io.sockets.adapter.rooms.has(`watch:${state.id}`))delivered.set(state.id,state.revision);else delivered.delete(state.id);
        }}));
        offset=notices.at(-1)!.id;
      }catch(error){if(draining)break;if(Date.now()-lastWarning>5000){app.log.warn({err:error},'Game update stream will retry');lastWarning=Date.now();}await delay(250);}
    }
  })().catch(error=>{if(!draining)app.log.error({err:error},'Game update reader stopped; clients retain periodic sync');});
  io.use((socket,next)=>{void(async()=>{
    if(draining||!games.health.ready)throw new Error('Service is reconnecting');
    const token=app.parseCookie(socket.handshake.headers.cookie??'')[SESSION_COOKIE];const session=await auth.lookup(token);
    socket.data={token,user:session?.user??null,expiresAt:session?.expiresAt??Number.MAX_SAFE_INTEGER,game:null};
    if(session){await socket.join(`user:${session.user.id}`);await socket.join(`session:${session.tokenHash}`);}next();
  })().catch(()=>next(new Error('The service is reconnecting. Please try again.')));});
  async function leave(socket:GameSocket,updatePresence=true):Promise<void>{
    const current=socket.data.game;if(!current)return;socket.data.game=null;
    await socket.leave(current.room);
    await socket.leave(`watch:${current.id}`);if(!io.sockets.adapter.rooms.has(`watch:${current.id}`))delivered.delete(current.id);
    if(!updatePresence)return;
    if(current.seat===null){if(games.kv.isReady)await games.kv.zRem(`bw:spectators:${current.id}`,current.member);}
    else if(socket.data.user&&games.kv.isReady)await games.connect(current.id,socket.data.user,current.member,false);
  }
  async function subscribe(socket:GameSocket,payload:unknown,ack:Ack):Promise<void>{
    const {gameId}=subscribeSchema.parse(payload);
    await rateLimit(games.kv,`subscribe:${socket.id}`,20,10000);
    const session=await auth.lookup(socket.data.token);
    if(socket.data.game?.id!==gameId||socket.data.user?.id!==session?.user.id)await leave(socket);
    socket.data.user=session?.user??null;socket.data.expiresAt=session?.expiresAt??Number.MAX_SAFE_INTEGER;
    const row=await games.read(gameId);const seat=games.seat(row.state,socket.data.user?.id);const member=`${games.health.epoch}/${socket.id}`;
    let view:GameView;
    if(seat!==null&&socket.data.user&&session){const room=`game:${gameId}:player:${seat}:session:${session.tokenHash}`;await socket.join([room,`watch:${gameId}`]);socket.data.game={id:gameId,seat,member,room};view=await games.connect(gameId,socket.data.user,member,true);}
    else{
      const admitted=Number(await games.kv.eval(SPECTATOR_ADD,{keys:[`bw:spectators:${gameId}`],arguments:[String(Date.now()),member,String(config.MAX_SPECTATORS_PER_GAME),String(Date.now()+16000)]}));
      if(!admitted)throw new HttpError(429,'SPECTATOR_LIMIT','This game has reached its live spectator limit. The replay will be available afterward.');
      const room=`game:${gameId}:spectators`;await socket.join([room,`watch:${gameId}`]);socket.data.game={id:gameId,seat:null,member,room};view=projectGame(row.state,null,Date.now(),await games.spectators(gameId));
    }
    safeAck(ack,{ok:true,view});
  }
  io.on('connection',socket=>{
    sockets.add(socket);
    let changes=Promise.resolve(),queued=0;
    const enqueue=(work:()=>Promise<void>,ack:Ack|SyncAck)=>{
      if(queued>=8){safeAck(ack,{ok:false,error:{code:'RATE_LIMITED',message:'Please wait for the current game connection.'}});return;}
      queued++;
      const job=changes.then(async()=>{if(socket.connected)await work();}).catch(error=>safeAck(ack,commandError(error))).finally(()=>{queued--;if(!socket.connected&&subscriptionWork.get(socket)===job)subscriptionWork.delete(socket);});
      changes=job;subscriptionWork.set(socket,job);
    };
    socket.on('lobby:subscribe',ack=>{void socket.join('lobby');if(typeof ack==='function')ack({ok:true});});
    socket.on('game:subscribe',(payload,ack)=>enqueue(()=>subscribe(socket,payload,ack),ack));
    socket.on('game:sync',(payload,ack)=>enqueue(async()=>{
      const input=syncSchema.parse(payload);const session=await auth.lookup(socket.data.token);
      if(input.revision!==undefined&&socket.data.game?.id===input.gameId&&socket.data.user?.id===session?.user.id){
        await rateLimit(games.kv,`sync:${socket.id}`,20,10000);
        const result=await games.db.pool.query<{revision:number;status:string;now:string}>('SELECT revision,status,(extract(epoch from clock_timestamp())*1000)::bigint AS now FROM games WHERE id=$1',[input.gameId]);
        const row=result.rows[0];
        if(row&&row.revision===input.revision&&row.status!=='paused'){
          if(typeof ack==='function')ack({ok:true,unchanged:true,serverTime:Number(row.now)});return;
        }
      }
      await subscribe(socket,{gameId:input.gameId},ack);
    },ack));
    socket.on('game:command',(payload,ack)=>{void(async()=>{
      const session=await auth.lookup(socket.data.token);if(!session)throw new HttpError(401,'AUTH_REQUIRED','Please sign in again.');
      const command=gameCommandSchema.parse(payload);safeAck(ack,await games.command(command,session.user));
    })().catch(error=>safeAck(ack,commandError(error)));});
    socket.on('disconnect',()=>{
      sockets.delete(socket);
      // Complete an in-flight subscription before removing its rooms/lease, so
      // an async continuation cannot recreate orphan membership after closure.
      const cleanup=changes.then(()=>leave(socket,!draining)).catch(error=>app.log.warn({err:error},'Presence cleanup will recover from its lease')).finally(()=>{if(subscriptionWork.get(socket)===cleanup)subscriptionWork.delete(socket);});
      changes=cleanup;subscriptionWork.set(socket,cleanup);
    });
  });
  let pulsing=false;
  const heartbeat=setInterval(()=>{if(pulsing||draining||!games.kv.isReady)return;pulsing=true;void(async()=>{
    const now=Date.now();const entries:Array<{key:string;member:string;deadline:number}>=[];
    const hashes=[...new Set([...sockets].filter(socket=>socket.data.user&&socket.data.token).map(socket=>digestToken(socket.data.token!)))];
    const valid=new Set(hashes.length?(await games.db.pool.query<{token_hash:string}>('SELECT token_hash FROM sessions WHERE token_hash=ANY($1::text[]) AND expires_at>$2',[hashes,now])).rows.map(row=>row.token_hash):[]);
    for(const socket of sockets){
      if(now>=socket.data.expiresAt||(socket.data.user&&(!socket.data.token||!valid.has(digestToken(socket.data.token))))){socket.disconnect(true);continue;}
      const game=socket.data.game;
      if(game){const key=game.seat===null?`bw:spectators:${game.id}`:`bw:presence:${game.id}:${game.seat}`;entries.push({key,member:game.member,deadline:now+16000});}
      if(socket.rooms.has('lobby')&&socket.data.user)entries.push({key:`bw:lobby:${socket.data.user.id}`,member:'',deadline:0});
    }
    // Bounded atomic batches never leave a partially enqueued MULTI transaction
    // on the shared Redis connection when thousands of sockets refresh together.
    const script="for i,key in ipairs(KEYS) do local member=ARGV[i*2-1];if member=='' then redis.call('SET',key,'1','PX',30000) else redis.call('ZADD',key,ARGV[i*2],member);redis.call('PEXPIRE',key,45000) end end;return #KEYS";
    for(let index=0;index<entries.length;index+=200){const chunk=entries.slice(index,index+200);await games.kv.eval(script,{keys:chunk.map(entry=>entry.key),arguments:chunk.flatMap(entry=>[entry.member,String(entry.deadline)])});}
  })().catch(error=>app.log.warn({err:error},'Presence heartbeat failed')).finally(()=>{pulsing=false;});},5000);heartbeat.unref();
  return {io,stop:async()=>{draining=true;clearInterval(heartbeat);io.emit('server:reconnecting');await games.health.stop();if(reader.isOpen)reader.destroy();await consumer;await new Promise<void>(resolve=>io.close(()=>resolve()));await Promise.allSettled([...subscriptionWork.values()]);}};
}
