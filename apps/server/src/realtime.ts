import { Server,type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
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
const broadcastWrites=new AsyncLocalStorage<Promise<unknown>[]>();
function durableAdapter(kv:KeyValue){
  const factory=createAdapter(kv,{streamName:'bw:socket-stream',maxLen:10000});
  return function(...args:Parameters<typeof factory>){
    const adapter=factory(...args);const publish=adapter.doPublish.bind(adapter);
    // Socket.IO's emit returns before XADD, and its cluster adapter absorbs XADD
    // failures. Observe the adapter's write promise before retiring our outbox.
    adapter.doPublish=(message:Parameters<typeof publish>[0])=>{
      const write=Promise.resolve(publish(message));write.catch(()=>{});
      broadcastWrites.getStore()?.push(write);return write;
    };
    return adapter;
  };
}
export function commandError(error:unknown):CommandReply {
  if(error instanceof HttpError||error instanceof EngineError)return {ok:false,error:{code:error.code,message:error.message}};
  if(error instanceof z.ZodError)return {ok:false,error:{code:'INVALID_REQUEST',message:'The request is not valid.'}};
  return {ok:false,error:{code:'SERVICE_RECOVERING',message:'The service is reconnecting. Your accepted moves are saved.'}};
}
function safeAck(ack:Ack|undefined,reply:CommandReply):void{if(typeof ack==='function')ack(reply);}
export async function publishGame(io:GameIO,games:Games,state:EngineState):Promise<void>{
  if(!games.kv.isReady)throw new Error('Broadcast unavailable');
  const spectators=await games.spectators(state.id);
  const time=await games.db.pool.query<{now:string}>('SELECT (extract(epoch from clock_timestamp())*1000)::bigint AS now');const now=Number(time.rows[0]!.now);
  // Session-specific rooms make a lost cross-gateway logout notification safe:
  // revoked sessions are excluded before every private publication.
  const sessions=await games.db.pool.query<{token_hash:string;user_id:string}>('SELECT token_hash,user_id FROM sessions WHERE user_id=ANY($1::uuid[]) AND expires_at>$2',[state.players.map(player=>player.id),now]);
  const writes:Promise<unknown>[]=[];
  broadcastWrites.run(writes,()=>{
    for(const seat of [0,1] as const){
      const rooms=sessions.rows.filter(session=>session.user_id===state.players[seat].id).map(session=>`game:${state.id}:player:${seat}:session:${session.token_hash}`);
      if(rooms.length)io.to(rooms).emit('game:update',projectGame(state,seat,now,spectators));
    }
    io.to(`game:${state.id}:spectators`).emit('game:update',projectGame(state,null,now,spectators));
    if(state.status==='finished')io.to('lobby').emit('lobby:changed');
  });
  await Promise.all(writes);
}
export function createPublisher(kv:KeyValue):GameIO{return new Server<Incoming,Outgoing,Record<string,never>,SocketData>({adapter:durableAdapter(kv)});}
export function attachRealtime(app:FastifyInstance,auth:Auth,games:Games,config:Config):{io:GameIO;stop:()=>Promise<void>} {
  const allowedOrigin=new URL(config.APP_ORIGIN).origin;
  const io:GameIO=new Server(app.server,{transports:['websocket'],pingInterval:5000,pingTimeout:10000,maxHttpBufferSize:16384,serveClient:false,adapter:durableAdapter(games.kv),allowRequest:(request,callback)=>callback(null,!request.headers.origin||request.headers.origin===allowedOrigin)});
  games.publish=state=>publishGame(io,games,state);
  auth.onSessionRevoked=hash=>{io.in(`session:${hash}`).disconnectSockets(true);};
  auth.onUserSessionsRevoked=id=>{io.in(`user:${id}`).disconnectSockets(true);};
  const sockets=new Set<GameSocket>();
  let draining=false;
  io.use((socket,next)=>{void(async()=>{
    if(draining||!games.health.ready)throw new Error('Service is reconnecting');
    const token=app.parseCookie(socket.handshake.headers.cookie??'')[SESSION_COOKIE];const session=await auth.lookup(token);
    socket.data={token,user:session?.user??null,expiresAt:session?.expiresAt??Number.MAX_SAFE_INTEGER,game:null};
    if(session){await socket.join(`user:${session.user.id}`);await socket.join(`session:${session.tokenHash}`);}next();
  })().catch(()=>next(new Error('The service is reconnecting. Please try again.')));});
  async function leave(socket:GameSocket):Promise<void>{
    const current=socket.data.game;if(!current)return;socket.data.game=null;
    await socket.leave(current.room);
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
    if(seat!==null&&socket.data.user&&session){const room=`game:${gameId}:player:${seat}:session:${session.tokenHash}`;await socket.join(room);socket.data.game={id:gameId,seat,member,room};view=await games.connect(gameId,socket.data.user,member,true);}
    else{
      const admitted=Number(await games.kv.eval(SPECTATOR_ADD,{keys:[`bw:spectators:${gameId}`],arguments:[String(Date.now()),member,String(config.MAX_SPECTATORS_PER_GAME),String(Date.now()+16000)]}));
      if(!admitted)throw new HttpError(429,'SPECTATOR_LIMIT','This game has reached its live spectator limit. The replay will be available afterward.');
      const room=`game:${gameId}:spectators`;await socket.join(room);socket.data.game={id:gameId,seat:null,member,room};view=projectGame(row.state,null,Date.now(),await games.spectators(gameId));
    }
    safeAck(ack,{ok:true,view});
  }
  io.on('connection',socket=>{
    sockets.add(socket);
    socket.on('lobby:subscribe',ack=>{void socket.join('lobby');if(typeof ack==='function')ack({ok:true});});
    socket.on('game:subscribe',(payload,ack)=>{void subscribe(socket,payload,ack).catch(error=>safeAck(ack,commandError(error)));});
    socket.on('game:sync',(payload,ack)=>{void(async()=>{
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
    })().catch(error=>safeAck(ack,commandError(error)));});
    socket.on('game:command',(payload,ack)=>{void(async()=>{
      const session=await auth.lookup(socket.data.token);if(!session)throw new HttpError(401,'AUTH_REQUIRED','Please sign in again.');
      const command=gameCommandSchema.parse(payload);safeAck(ack,await games.command(command,session.user));
    })().catch(error=>safeAck(ack,commandError(error)));});
    socket.on('disconnect',()=>{sockets.delete(socket);if(!draining)void leave(socket).catch(error=>app.log.warn({err:error},'Presence cleanup will recover from its lease'));});
  });
  let pulsing=false;
  const heartbeat=setInterval(()=>{if(pulsing||draining||!games.kv.isReady)return;pulsing=true;void(async()=>{
    const now=Date.now();const batch=games.kv.multi();
    const hashes=[...new Set([...sockets].filter(socket=>socket.data.user&&socket.data.token).map(socket=>digestToken(socket.data.token!)))];
    const valid=new Set(hashes.length?(await games.db.pool.query<{token_hash:string}>('SELECT token_hash FROM sessions WHERE token_hash=ANY($1::text[]) AND expires_at>$2',[hashes,now])).rows.map(row=>row.token_hash):[]);
    for(const socket of sockets){
      if(now>=socket.data.expiresAt||(socket.data.user&&(!socket.data.token||!valid.has(digestToken(socket.data.token))))){socket.disconnect(true);continue;}
      const game=socket.data.game;
      if(game){const key=game.seat===null?`bw:spectators:${game.id}`:`bw:presence:${game.id}:${game.seat}`;batch.zAdd(key,{score:now+16000,value:game.member}).pExpire(key,45000);}
      if(socket.rooms.has('lobby')&&socket.data.user)batch.set(`bw:lobby:${socket.data.user.id}`,'1',{PX:30000});
    }
    await batch.exec();
  })().catch(error=>app.log.warn({err:error},'Presence heartbeat failed')).finally(()=>{pulsing=false;});},5000);heartbeat.unref();
  return {io,stop:async()=>{draining=true;clearInterval(heartbeat);io.emit('server:reconnecting');await games.health.stop();await new Promise<void>(resolve=>io.close(()=>resolve()));}};
}
