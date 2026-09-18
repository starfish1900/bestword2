import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID,timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { seekSchema,type Seek,type SeekPage,type GamePage } from '@bestword/contracts';
import { Gaddag } from '@bestword/lexicon';
import { EngineError } from '@bestword/engine';
import type { Config } from './config.js';
import { createDatabase,migrate,transaction,databaseNow,type GameRow } from './db.js';
import { createKeyValue,rateLimit } from './kv.js';
import { Auth } from './auth.js';
import { Games } from './games.js';
import { Health } from './health.js';
import { HttpError,isPgError } from './errors.js';
import { attachRealtime } from './realtime.js';

const idSchema=z.object({id:z.uuid()});
const pageSchema=z.object({cursor:z.string().max(100).optional(),minutes:z.coerce.number().pipe(z.union([z.literal(5),z.literal(15),z.literal(25)])).optional(),username:z.string().max(15).optional()});
function cursorParts(cursor:string|undefined):[number,string]|null{if(!cursor)return null;try{const pair=JSON.parse(Buffer.from(cursor,'base64url').toString()) as unknown;return z.tuple([z.number().int().nonnegative(),z.uuid()]).parse(pair);}catch{throw new HttpError(400,'INVALID_CURSOR','The page cursor is invalid.');}}
function encodeCursor(time:number,id:string):string{return Buffer.from(JSON.stringify([time,id])).toString('base64url');}
export async function buildApp(config:Config){
  const app=Fastify({logger:{level:config.LOG_LEVEL,redact:['req.headers.cookie','req.headers.authorization','password','body.password','body.currentPassword','body.newPassword']},bodyLimit:16384,trustProxy:config.NODE_ENV==='production'?(_address:string,hop:number)=>hop<1:false,requestTimeout:15000});
  const db=createDatabase(config.DATABASE_URL,config.DB_POOL_SIZE);const kv=createKeyValue(config.REDIS_URL);
  await kv.connect();await migrate(db);const lexicon=await Gaddag.open(config.LEXICON_PATH);
  const health=new Health(db,kv,'api');await health.start();const auth=new Auth(db,kv,config);const games=new Games(db,kv,health,lexicon,config);
  await app.register(cookie);await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"]}},crossOriginEmbedderPolicy:false});
  app.addHook('onRequest',async(request,reply)=>{
    if(request.url.startsWith('/api/'))reply.header('Cache-Control','no-store');
    if(['POST','PUT','PATCH','DELETE'].includes(request.method)){
      const origin=request.headers.origin;const expected=new URL(config.APP_ORIGIN).origin;
      if((origin&&origin!==expected)||request.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'ORIGIN_REJECTED','This request came from another website.');
    }
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'INVALID_REQUEST',message:'Please check the supplied fields.',details:{fields:error.flatten().fieldErrors}}});
    if(error instanceof HttpError)return reply.code(error.statusCode).send({error:error.toJSON()});
    if(error instanceof EngineError)return reply.code(400).send({error:{code:error.code,message:error.message}});
    if(error instanceof Error&&'statusCode'in error&&typeof error.statusCode==='number'&&error.statusCode>=400&&error.statusCode<500)return reply.code(error.statusCode).send({error:{code:'INVALID_REQUEST',message:error.statusCode===413?'This request is too large.':'The request could not be read. Please check its format.'}});
    app.log.error({err:error,requestId:request.id},'Request failed');return reply.code(503).send({error:{code:'SERVICE_RECOVERING',message:'The service is reconnecting. Please try again shortly.'}});
  });
  app.get('/health/live',async()=>({ok:true}));
  app.get('/health/ready',async(_request,reply)=>reply.code(health.ready&&kv.isReady?200:503).send({ok:health.ready&&kv.isReady,lexicon:lexicon.sha256}));
  auth.register(app);
  const realtime=attachRealtime(app,auth,games,config);
  app.get('/api/seeks',async request=>{
    const query=pageSchema.parse(request.query);const cursor=cursorParts(query.cursor);
    const rows=await db.pool.query<{id:string;user_id:string;username:string;minutes:5|15|25;created_at:string}>(`SELECT s.*,u.username FROM seeks s JOIN users u ON u.id=s.user_id WHERE s.expires_at>(extract(epoch from clock_timestamp())*1000)::bigint AND ($1::int IS NULL OR s.minutes=$1) AND ($2::bigint IS NULL OR (s.created_at,s.id)<($2,$3::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT 51`,[query.minutes??null,cursor?.[0]??null,cursor?.[1]??null]);
    const visible=rows.rows.slice(0,50);const last=visible.at(-1);
    return {items:visible.map(row=>({id:row.id,host:{id:row.user_id,username:row.username},minutes:row.minutes,createdAt:Number(row.created_at)})),nextCursor:rows.rows.length>50&&last?encodeCursor(Number(last.created_at),last.id):null} satisfies SeekPage;
  });
  app.post('/api/seeks',async(request,reply)=>{
    const session=await auth.require(request);await rateLimit(kv,`seek:${session.user.id}`,10,60000);const input=seekSchema.parse(request.body);
    const seek:Seek=await transaction(db,async c=>{
      // The same admission lock orders seek creation against claims and playing-slot changes.
      await c.query('SELECT pg_advisory_xact_lock(421715012)');const now=await databaseNow(c);
      const slot=await c.query('SELECT 1 FROM playing_slots WHERE user_id=$1',[session.user.id]);if(slot.rowCount)throw new HttpError(409,'ALREADY_PLAYING','Finish or pass your current game before creating another.');
      const id=randomUUID();const row=await c.query<{id:string;created_at:string}>(`INSERT INTO seeks(id,user_id,minutes,created_at,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET minutes=EXCLUDED.minutes,expires_at=EXCLUDED.expires_at RETURNING id,created_at`,[id,session.user.id,input.minutes,now,now+300000]);
      return {id:row.rows[0]!.id,host:session.user,minutes:input.minutes,createdAt:Number(row.rows[0]!.created_at)};
    });realtime.io.to('lobby').emit('lobby:changed');return reply.code(201).send({seek});
  });
  app.delete('/api/seeks/:id',async request=>{const session=await auth.require(request);const {id}=idSchema.parse(request.params);await db.pool.query('DELETE FROM seeks WHERE id=$1 AND user_id=$2',[id,session.user.id]);realtime.io.to('lobby').emit('lobby:changed');return {ok:true};});
  app.post('/api/seeks/:id/join',async request=>{const session=await auth.require(request);const {id}=idSchema.parse(request.params);await rateLimit(kv,`join:${session.user.id}`,10,60000);const gameId=await games.join(id,session.user);const row=await games.read(gameId);for(const player of row.state.players)realtime.io.to(`user:${player.id}`).emit('game:matched',{gameId});realtime.io.to('lobby').emit('lobby:changed');return {gameId};});
  for(const category of ['live','history'] as const)app.get(`/api/games/${category}`,async request=>{
    const query=pageSchema.parse(request.query);const cursor=cursorParts(query.cursor);
    const result=await db.pool.query<GameRow>(`SELECT g.* FROM games g WHERE ${category==='live'?"g.status<>'finished'":"g.status='finished'"} AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM game_players p JOIN users u ON p.user_id=u.id WHERE p.game_id=g.id AND u.username_key=$1)) AND ($2::bigint IS NULL OR (g.created_at,g.id)<($2,$3::uuid)) ORDER BY g.created_at DESC,g.id DESC LIMIT 51`,[query.username?.toLowerCase()??null,cursor?.[0]??null,cursor?.[1]??null]);
    const visible=result.rows.slice(0,50);const last=visible.at(-1);return {items:visible.map(row=>games.summary(row)),nextCursor:result.rows.length>50&&last?encodeCursor(Number(last.created_at),last.id):null} satisfies GamePage;
  });
  app.get('/api/games/:id',async request=>{const {id}=idSchema.parse(request.params);const session=await auth.lookup(request.cookies.bw_session);return games.view(id,session?.user.id);});
  app.get('/metrics',async(request,reply)=>{
    const supplied=request.headers.authorization?.replace(/^Bearer /,'')??'';const expected=config.METRICS_TOKEN??'';
    const suppliedBytes=Buffer.from(supplied),expectedBytes=Buffer.from(expected);
    if(config.NODE_ENV==='production'&&(!expected||suppliedBytes.length!==expectedBytes.length||!timingSafeEqual(suppliedBytes,expectedBytes)))return reply.code(404).send();
    const result=await db.pool.query<{status:string;count:string}>('SELECT status,count(*) AS count FROM games GROUP BY status');
    const memory=process.memoryUsage();return reply.type('text/plain; version=0.0.4').send(['# TYPE bestword_active_games gauge',...result.rows.map(row=>`bestword_active_games{status="${row.status}"} ${row.count}`),`bestword_process_rss_bytes ${memory.rss}`,`bestword_socket_connections ${realtime.io.engine.clientsCount}`,`bestword_database_pool_waiting ${db.pool.waitingCount}`,`bestword_service_ready ${health.ready?1:0}`,''].join('\n'));
  });
  const webRoot=resolve('apps/web/dist');if(existsSync(resolve(webRoot,'index.html'))){await app.register(staticFiles,{root:webRoot,index:false,redirect:false,list:false,preCompressed:true,setHeaders:(response,path)=>response.header('Cache-Control',path.includes(`${process.platform==='win32'?'\\':'/'}assets${process.platform==='win32'?'\\':'/'}`)?'public, max-age=31536000, immutable':'no-cache')});app.setNotFoundHandler((request,reply)=>{if(request.method==='GET'&&!request.url.startsWith('/api/')&&!request.url.startsWith('/assets/')&&request.headers.accept?.includes('text/html'))return reply.header('Cache-Control','no-cache').sendFile('index.html');return reply.code(404).send({error:{code:'NOT_FOUND',message:'This page was not found.'}});});}
  let closing=false;let cycle:Promise<void>|null=null;
  // Every gateway can take over the scheduler if the worker stops. Row locks and
  // SKIP LOCKED claims make this safe across any number of instances.
  const scheduler=setInterval(()=>{if(closing||cycle)return;cycle=games.tick().catch(error=>app.log.error({err:error},'Deadline processing will retry')).finally(()=>{cycle=null;});},config.WORKER_INTERVAL_MS);scheduler.unref();
  async function close():Promise<void>{if(closing)return;closing=true;clearInterval(scheduler);await cycle;await realtime.stop();await app.close();await kv.close();await db.pool.end();}
  return {app,db,kv,health,auth,games,io:realtime.io,close};
}
