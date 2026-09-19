import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import pg from 'pg';
import { randomBytes,randomUUID } from 'node:crypto';
import { hash,Algorithm } from '@node-rs/argon2';
import { io as clientIO,type Socket } from 'socket.io-client';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { digestToken } from './auth.js';
import type { CommandReply,GameAction,GameView,User } from '@bestword/contracts';
import { findMove } from '../../../tools/testing/moves.js';

const enabled=process.env.BESTWORD_INTEGRATION==='1';
type App=Awaited<ReturnType<typeof buildApp>>;
type Player={user:User;cookie:string};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,timeout=10000):Promise<T>{const until=Date.now()+timeout;let last:T;do{last=await read();if(accept(last))return last;await delay(80);}while(Date.now()<until);throw new Error(`Condition timed out: ${JSON.stringify(last!)}`);}
describe.skipIf(!enabled)('real database, multiple gateways, and WebSocket integration',()=>{
  const schema=`bw_integration_${randomBytes(6).toString('hex')}`;
  let admin:pg.Pool;let a:App;let b:App;let urlA:string;let urlB:string;
  const sockets:Socket[]=[];const runId=randomBytes(3).toString('hex');let serial=0;
  let databaseUrl:string;
  function config(){return readConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl,REDIS_URL:process.env.REDIS_URL??'redis://127.0.0.1:6389',APP_ORIGIN:'http://localhost:5173',LOG_LEVEL:'silent',MAX_ACTIVE_GAMES:'100',WORKER_INTERVAL_MS:'100'});}
  beforeAll(async()=>{
    const base=process.env.DATABASE_URL??'postgresql://bestword:bestword-local@127.0.0.1:54329/bestword';admin=new pg.Pool({connectionString:base});await admin.query(`CREATE SCHEMA ${schema}`);
    const parsed=new URL(base);parsed.searchParams.set('options',`-c search_path=${schema}`);databaseUrl=parsed.toString();
    a=await buildApp(config());b=await buildApp(config());urlA=await a.app.listen({host:'127.0.0.1',port:0});urlB=await b.app.listen({host:'127.0.0.1',port:0});
  });
  afterAll(async()=>{for(const socket of sockets)socket.disconnect();await Promise.allSettled([a?.close(),b?.close()]);if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
  async function player():Promise<Player>{const user={id:randomUUID(),username:`P${runId}${++serial}`};const token=randomBytes(32).toString('hex');await a.db.pool.query('INSERT INTO users(id,username,username_key,password_hash,created_at) VALUES($1,$2,$3,$4,$5)',[user.id,user.username,user.username.toLowerCase(),'test-fixture-no-password-login',Date.now()]);await a.db.pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[digestToken(token),user.id,Date.now()+3600000]);return {user,cookie:`bw_session=${token}`};}
  async function api(app:App,path:string,p?:Player,body?:unknown,method:'GET'|'POST'|'DELETE'=body===undefined?'GET':'POST'){return app.app.inject({method,url:path,headers:{...(p?{cookie:p.cookie}:{}),origin:'http://localhost:5173'},...(body===undefined?{}:{payload:body as object}),remoteAddress:`198.18.${parseInt(runId.slice(0,2),16)}.${Math.max(1,serial)}`});}
  async function connect(url:string,p?:Player):Promise<Socket>{const socket=clientIO(url,{transports:['websocket'],forceNew:true,reconnection:false,extraHeaders:{Origin:'http://localhost:5173',...(p?{Cookie:p.cookie}:{})}});sockets.push(socket);await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;}
  function ack(socket:Socket,event:string,payload:unknown):Promise<CommandReply>{return socket.timeout(6000).emitWithAck(event,payload) as Promise<CommandReply>;}
  async function newGame(){const p0=await player(),p1=await player();const seek=await api(a,'/api/seeks',p0,{minutes:5});expect(seek.statusCode).toBe(201);const joined=await api(b,`/api/seeks/${seek.json().seek.id}/join`,p1,{});expect(joined.statusCode).toBe(200);return {gameId:joined.json().gameId as string,p0,p1};}
  async function readyGame(){const game=await newGame();const s0=await connect(urlA,game.p0),s1=await connect(urlB,game.p1);expect((await ack(s0,'game:subscribe',{gameId:game.gameId})).ok).toBe(true);expect((await ack(s1,'game:subscribe',{gameId:game.gameId})).ok).toBe(true);await eventually(()=>a.games.read(game.gameId),r=>r.state.status==='active'&&r.state.startsAt===null);return {...game,s0,s1};}
  async function command(gameId:string,p:Player,action:GameAction){const row=await a.games.read(gameId);return a.games.command({gameId,commandId:randomUUID(),expectedRevision:row.revision,action},p.user);}

  it('registers securely, enforces case-insensitive names, logs in, and revokes sessions',async()=>{
    const username=`A${runId}`;const password='correct horse 726';
    const address=`198.19.${parseInt(runId.slice(0,2),16)}.${parseInt(runId.slice(2,4),16)}`;
    const response=await a.app.inject({method:'POST',url:'/api/auth/register',remoteAddress:address,payload:{username,password}});expect(response.statusCode).toBe(201);
    const cookie=String(response.headers['set-cookie']).split(';')[0]!;expect(response.headers['set-cookie']).toContain('HttpOnly');expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    const user=response.json().user as User;const p={user,cookie};expect((await api(b,'/api/session',p)).json().user).toEqual(user);
    const duplicate=await a.app.inject({method:'POST',url:'/api/auth/register',remoteAddress:address,payload:{username:username.toLowerCase(),password}});expect(duplicate.statusCode).toBe(409);
    const bad=await a.app.inject({method:'POST',url:'/api/auth/login',payload:{username,password:'wrong password 111'}});expect(bad.statusCode).toBe(401);
    const login=await b.app.inject({method:'POST',url:'/api/auth/login',payload:{username:username.toLowerCase(),password}});expect(login.statusCode).toBe(200);
    const socket=await connect(urlB,p);const disconnected=new Promise<void>(resolve=>socket.once('disconnect',()=>resolve()));
    expect((await api(a,'/api/auth/logout',p,{})).statusCode).toBe(200);await disconnected;expect((await api(a,'/api/session',p)).json().user).toBeNull();
    const hash=(await a.db.pool.query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0].password_hash;expect(hash).toMatch(/^\$argon2id\$/);expect(hash).not.toContain(password);
  });
  it('rejects cross-origin mutations and invalid inputs without leaking internals',async()=>{
    const rejected=await a.app.inject({method:'POST',url:'/api/auth/register',headers:{origin:'https://other.invalid'},payload:{username:'abc',password:'abcdefghijkl'}});expect(rejected.statusCode).toBe(403);
    const malformed=await api(a,'/api/games/not-a-uuid');expect(malformed.statusCode).toBe(400);expect(JSON.stringify(malformed.json())).not.toMatch(/stack|password_hash|SELECT /);
    expect((await api(a,'/api/seeks',undefined,{minutes:5})).statusCode).toBe(401);
    const badJson=await a.app.inject({method:'POST',url:'/api/seeks',headers:{'content-type':'application/json'},payload:'{'});expect(badJson.statusCode).toBe(400);
  });
  it('cannot issue a session from an old password after concurrent password revocation',async()=>{
    const p=await player(),password='Original password 8931';
    const options={algorithm:Algorithm.Argon2id,memoryCost:19456,timeCost:2,parallelism:1};
    const original=await hash(password,options),replacement=await hash('Replacement password 8931',options);
    await a.db.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[p.user.id,original]);
    const locker=await a.db.pool.connect();let response:ReturnType<typeof api>|undefined;
    try{
      await locker.query('BEGIN');await locker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[p.user.id]);
      const pid=(await locker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      response=api(b,'/api/auth/login',undefined,{username:p.user.username,password});
      await eventually(()=>admin.query<{blocked:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid]),r=>r.rows[0]!.blocked,3000);
      await locker.query('UPDATE users SET password_hash=$2 WHERE id=$1',[p.user.id,replacement]);await locker.query('DELETE FROM sessions WHERE user_id=$1',[p.user.id]);await locker.query('COMMIT');
      expect((await response).statusCode).toBe(401);expect((await a.db.pool.query('SELECT 1 FROM sessions WHERE user_id=$1',[p.user.id])).rowCount).toBe(0);
    }finally{await locker.query('ROLLBACK').catch(()=>{});locker.release();await response?.catch(()=>{});}
  });
  it('changes passwords atomically and revokes every preceding session',async()=>{
    const p=await player(),password='First secure password 992',next='Next secure password 993';
    await a.db.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[p.user.id,await hash(password,{algorithm:Algorithm.Argon2id,memoryCost:19456,timeCost:2,parallelism:1})]);
    const login=await api(b,'/api/auth/login',undefined,{username:p.user.username,password});expect(login.statusCode).toBe(200);
    const other={user:p.user,cookie:String(login.headers['set-cookie']).split(';')[0]!};
    const changed=await api(a,'/api/auth/password',p,{currentPassword:password,newPassword:next});expect(changed.statusCode).toBe(200);
    expect((await api(b,'/api/session',p)).json().user).toBeNull();expect((await api(b,'/api/session',other)).json().user).toBeNull();
    const current={user:p.user,cookie:String(changed.headers['set-cookie']).split(';')[0]!};expect((await api(b,'/api/session',current)).json().user).toEqual(p.user);
    expect((await api(a,'/api/auth/login',undefined,{username:p.user.username,password})).statusCode).toBe(401);
    expect((await api(a,'/api/auth/login',undefined,{username:p.user.username,password:next})).statusCode).toBe(200);
  });
  it('serializes overlapping subscriptions and removes the previous room and spectator lease',async()=>{
    const first=await newGame(),second=await newGame();const viewer=await connect(urlA);
    const replies=await Promise.all([ack(viewer,'game:subscribe',{gameId:first.gameId}),ack(viewer,'game:subscribe',{gameId:second.gameId})]);expect(replies.every(reply=>reply.ok)).toBe(true);
    const serverSocket=a.io.sockets.sockets.get(viewer.id!);expect(serverSocket?.data.game?.id).toBe(second.gameId);
    expect(serverSocket?.rooms.has(`watch:${first.gameId}`)).toBe(false);expect(serverSocket?.rooms.has(`game:${first.gameId}:spectators`)).toBe(false);
    expect(await a.games.spectators(first.gameId)).toBe(0);expect(await a.games.spectators(second.gameId)).toBe(1);
  });
  it('keeps newly authenticated sockets when they arrive during a session heartbeat query',async()=>{
    const previous=await player(),next=await player();const oldSocket=await connect(urlA,previous);
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const original=a.db.pool.query;let held=false;let fresh:Socket|undefined;
    // Delay only delivery of this real query's result. Authentication and all
    // other database operations continue while the new socket joins the set.
    a.db.pool.query=((...args:unknown[])=>{
      const result=Reflect.apply(original,a.db.pool,args);
      if(!held&&typeof args[0]==='string'&&args[0].startsWith('SELECT s.token_hash FROM sessions s JOIN users')){
        held=true;return Promise.resolve(result).then(async value=>{entered.resolve();await release.promise;return value;});
      }
      return result;
    }) as typeof original;
    try{
      await a.db.pool.query('DELETE FROM sessions WHERE token_hash=$1',[digestToken(previous.cookie.split('=')[1]!)]);
      await eventually(async()=>{await Promise.race([entered.promise,delay(20)]);return held;},Boolean,6500);
      fresh=await connect(urlA,next);
      const revoked=new Promise<void>(resolve=>oldSocket.once('disconnect',()=>resolve()));
      release.resolve();await revoked;
      expect(await fresh.timeout(2000).emitWithAck('lobby:subscribe')).toEqual({ok:true});
      expect(fresh.connected).toBe(true);
    }finally{release.resolve();a.db.pool.query=original;oldSocket.disconnect();fresh?.disconnect();}
  });
  it('atomically resolves two simultaneous joins and prevents a second active slot',async()=>{
    const host=await player(),one=await player(),two=await player();const seek=(await api(a,'/api/seeks',host,{minutes:15})).json().seek;
    const responses=await Promise.all([api(a,`/api/seeks/${seek.id}/join`,one,{}),api(b,`/api/seeks/${seek.id}/join`,two,{})]);expect(responses.filter(r=>r.statusCode===200)).toHaveLength(1);expect(responses.filter(r=>r.statusCode===404||r.statusCode===409)).toHaveLength(1);
    expect((await api(b,'/api/seeks',host,{minutes:5})).statusCode).toBe(409);expect(Number((await a.db.pool.query('SELECT count(*) AS n FROM playing_slots WHERE user_id=$1',[host.user.id])).rows[0].n)).toBe(1);
  });
  it('starts without a worker, delivers private cross-gateway updates, and commits valid words idempotently',async()=>{
    const g=await readyGame();const spectator=await connect(urlB);const spec=await ack(spectator,'game:subscribe',{gameId:g.gameId});expect(spec.ok).toBe(true);if(!spec.ok)throw new Error('spectate failed');expect(spec.view.you).toBeNull();
    let row=await a.games.read(g.gameId);const active=row.state.activeSeat;const p=active===0?g.p0:g.p1;const socket=active===0?g.s0:g.s1;const other=active===0?g.s1:g.s0;
    const privateView=await a.games.view(g.gameId,p.user.id);expect(privateView.you?.rack).toHaveLength(2);
    expect(await ack(socket,'game:sync',{gameId:g.gameId,revision:row.revision})).toMatchObject({ok:true,unchanged:true});
    expect(JSON.stringify(spec.view)).not.toMatch(/consonantDrawOrder|"bag"|drawnThisTurn|"rack":/);
    const before=structuredClone(row.state);const invalid=await command(g.gameId,p,{type:'PLACE_WORD',row:0,column:0,direction:'H',word:'ZZZZZZ'});expect(invalid.ok).toBe(false);row=await a.games.read(g.gameId);expect(row.state).toEqual(before);
    const action=findMove(row.state,a.games.lexicon);expect(action).not.toBeNull();if(!action)throw new Error('No generated legal move');
    const sent={gameId:g.gameId,commandId:randomUUID(),expectedRevision:row.revision,action};
    const observed=new Promise<GameView>(resolve=>other.on('game:update',view=>{if(view.game.moves.length===1)resolve(view);}));
    const reply=await ack(socket,'game:command',sent);expect(reply.ok).toBe(true);if(!reply.ok)throw new Error(reply.error.message);const delivered=await observed;expect(delivered.you?.seat).toBe(active===0?1:0);expect(delivered.game.moves[0]?.score).toBeGreaterThanOrEqual(0);
    expect(delivered.you?.rack).toEqual((await a.games.read(g.gameId)).state.players[active===0?1:0].rack);
    const duplicate=await ack(socket,'game:command',sent);expect(duplicate).toMatchObject({ok:true,acceptedRevision:reply.acceptedRevision});expect((await a.games.read(g.gameId)).state.moves).toHaveLength(1);
    const reused=await ack(socket,'game:command',{...sent,action:{type:'PASS'}});expect(reused).toMatchObject({ok:false,error:{code:'COMMAND_ID_REUSED'}});
    const current=await a.games.read(g.gameId);const next=current.state.activeSeat;const nextPlayer=next===0?g.p0:g.p1;
    const races=await Promise.all([a.games.command({gameId:g.gameId,commandId:randomUUID(),expectedRevision:current.revision,action:{type:'NO_WORDS'}},nextPlayer.user),b.games.command({gameId:g.gameId,commandId:randomUUID(),expectedRevision:current.revision,action:{type:'NO_WORDS'}},nextPlayer.user)]);expect(races.filter(r=>r.ok)).toHaveLength(1);expect(races.filter(r=>!r.ok&&r.error.code==='STALE_REVISION')).toHaveLength(1);
    const replay=await ack(socket,'game:command',sent);expect(replay).toMatchObject({ok:true,acceptedRevision:reply.acceptedRevision});expect(replay.ok&&replay.view.game.revision).toBeGreaterThan(reply.acceptedRevision!);
  });
  it('permanent PASS releases the account slot and signed-in replay contains only accepted moves',async()=>{
    const g=await readyGame();let row=await a.games.read(g.gameId);const active=row.state.activeSeat;const p=active===0?g.p0:g.p1;const other=active===0?g.p1:g.p0;
    expect((await command(g.gameId,p,{type:'PASS'})).ok).toBe(true);row=await a.games.read(g.gameId);const frozen=row.state.clocksMs[active];expect((await api(a,'/api/session',p)).json().activeGameId).toBeNull();expect((await api(a,'/api/seeks',p,{minutes:25})).statusCode).toBe(201);
    expect(await command(g.gameId,other,{type:'NO_WORDS'})).toMatchObject({ok:false,error:{code:'NO_WORDS_UNAVAILABLE'}});
    expect((await command(g.gameId,other,{type:'PASS'})).ok).toBe(true);row=await a.games.read(g.gameId);expect(row.state.result?.reason).toBe('both-passed');expect(row.state.clocksMs[active]).toBe(frozen);
    const publicGame=(await api(b,`/api/games/${g.gameId}`)).json() as GameView;expect(publicGame.you).toBeNull();expect(publicGame.game.moves).toEqual([]);expect(publicGame.game.moveCount).toBe(2);expect(JSON.stringify(publicGame)).not.toMatch(/consonantDrawOrder|"bag"|"rack":/);
    expect((await api(b,`/api/games/${g.gameId}/replay`)).statusCode).toBe(401);
    const reader=await player();const replay=(await api(b,`/api/games/${g.gameId}/replay`,reader)).json() as GameView;
    expect(replay.you).toBeNull();expect(replay.game.historyAccess).toBe('full');expect(replay.game.moves.map(m=>m.action)).toEqual(['PASS','PASS']);
    expect((await api(a,`/api/games/history?username=${p.user.username}`)).json().items.some((item:{id:string})=>item.id===g.gameId)).toBe(true);
  });
  it('protects full history on live fetches, socket sync and terminal broadcasts, including revoked viewers',async()=>{
    const g=await readyGame(),reader=await player();
    const guest=await connect(urlB),signed=await connect(urlB,reader);
    expect(await ack(guest,'game:subscribe',{gameId:g.gameId,replay:true})).toMatchObject({ok:false,error:{code:'AUTH_REQUIRED'}});
    expect(await ack(guest,'game:sync',{gameId:g.gameId,replay:true})).toMatchObject({ok:false,error:{code:'AUTH_REQUIRED'}});
    expect(await ack(guest,'game:subscribe',{gameId:g.gameId})).toMatchObject({ok:true,view:{game:{historyAccess:'recent',moves:[]}}});
    expect(await ack(signed,'game:subscribe',{gameId:g.gameId,replay:true})).toMatchObject({ok:true,view:{game:{historyAccess:'full'}}});
    const guestUpdates:GameView[]=[],signedUpdates:GameView[]=[];
    guest.on('game:update',view=>guestUpdates.push(view));signed.on('game:update',view=>signedUpdates.push(view));
    for(let turn=0;turn<4;turn++){
      const row=await a.games.read(g.gameId);const p=row.state.activeSeat===0?g.p0:g.p1;
      const action=turn===0?findMove(row.state,a.games.lexicon):{type:'NO_WORDS' as const};
      expect(action).not.toBeNull();expect((await command(g.gameId,p,action!)).ok).toBe(true);
    }
    await eventually(async()=>signedUpdates,values=>values.some(view=>view.game.moves.length===4));
    const anonymous=(await api(a,`/api/games/${g.gameId}`)).json() as GameView;
    expect(anonymous.game.moves).toEqual([]);expect(anonymous.game.principalHistory).toHaveLength(2);
    expect(anonymous.game.recentMoves).toHaveLength(3);expect(anonymous.game.tileOrigins).toHaveLength(225);
    expect(anonymous.game.recentMoves?.every(move=>!('tiles'in move)&&!('words'in move))).toBe(true);
    expect((await api(a,`/api/games/${g.gameId}`,reader)).json().game.moves).toHaveLength(4);
    await a.db.pool.query('DELETE FROM sessions WHERE token_hash=$1',[digestToken(reader.cookie.split('=')[1]!)]);
    for(let turn=0;turn<2;turn++){const row=await a.games.read(g.gameId);expect((await command(g.gameId,row.state.activeSeat===0?g.p0:g.p1,{type:'PASS'})).ok).toBe(true);}
    await eventually(async()=>guestUpdates,values=>values.some(view=>view.game.status==='finished'));
    expect(guestUpdates.every(view=>view.game.moves.length===0&&view.game.historyAccess==='recent'&&view.you===null)).toBe(true);
    expect(signedUpdates.filter(view=>(view.game.moveCount??0)>4)).toEqual([]);
    expect((await api(a,`/api/games/${g.gameId}/replay`,reader)).statusCode).toBe(401);
    if(signed.connected)expect(await ack(signed,'game:sync',{gameId:g.gameId})).toMatchObject({ok:true,view:{you:null,game:{historyAccess:'recent',moves:[]}}});
  });
  it('adjudicates a near-zero clock only after healthy gateway evidence',async()=>{
    const g=await readyGame();const row=await a.games.read(g.gameId);const state=row.state;const now=Date.now();state.clocksMs[state.activeSeat]=150;state.turnStartedAt=now;state.turnDeadlineAt=now+150;state.lastTransitionAt=now;
    await a.db.pool.query('UPDATE games SET state=$2,next_deadline=$3 WHERE id=$1',[g.gameId,JSON.stringify(state),state.turnDeadlineAt]);
    const ended=await eventually(()=>a.games.read(g.gameId),r=>r.state.status==='finished');expect(ended.state.result).toMatchObject({reason:'clock',winner:state.activeSeat===0?1:0});
  });
  it('keeps the game connected while another authenticated tab remains',async()=>{
    const g=await readyGame();const second=await connect(urlB,g.p0);expect((await ack(second,'game:subscribe',{gameId:g.gameId})).ok).toBe(true);g.s0.disconnect();await delay(250);const row=await a.games.read(g.gameId);expect(row.state.players[0].connected).toBe(true);expect(row.state.disconnectDeadlines[0]).toBeNull();
    second.disconnect();await eventually(()=>a.games.read(g.gameId),r=>!r.state.players[0].connected);const absent=await a.games.read(g.gameId);expect(absent.state.disconnectDeadlines[0]).toBeGreaterThan(Date.now()+20000);
  });
  it('cancels an overdue waiting game when both saved connections have vanished',async()=>{
    const g=await newGame();const row=await a.games.read(g.gameId);const state=row.state;const now=Date.now();
    state.createdAt=now-30000;state.lastTransitionAt=now-29000;state.waitingDeadlineAt=now-5000;state.startsAt=now-26000;state.players[0].connected=true;state.players[1].connected=true;
    await a.db.pool.query('UPDATE games SET state=$2,created_at=$3,updated_at=$4,next_deadline=$5,gateways=$6 WHERE id=$1',[g.gameId,JSON.stringify(state),state.createdAt,state.lastTransitionAt,state.startsAt,JSON.stringify([[a.health.epoch],[b.health.epoch]])]);
    const ended=await eventually(()=>a.games.read(g.gameId),r=>r.state.status==='finished');expect(ended.state.result?.reason).toBe('start-cancelled');expect(ended.state.result?.winner).toBeNull();
  });
  it('retains a committed outbox entry when broadcasting fails and retries after recovery',async()=>{
    const g=await readyGame();const row=await a.games.read(g.gameId);const p=row.state.activeSeat===0?g.p0:g.p1;const sendA=a.games.publish,sendB=b.games.publish;a.games.publish=b.games.publish=async()=>{throw new Error('injected publication outage');};
    try{expect((await command(g.gameId,p,{type:'NO_WORDS'})).ok).toBe(true);const pending=await a.db.pool.query('SELECT * FROM outbox WHERE game_id=$1',[g.gameId]);expect(pending.rowCount).toBeGreaterThan(0);expect((await a.games.read(g.gameId)).state.moves).toHaveLength(1);}finally{a.games.publish=sendA;b.games.publish=sendB;}
    await a.db.pool.query('UPDATE outbox SET claimed_until=0 WHERE game_id=$1',[g.gameId]);await eventually(()=>a.db.pool.query('SELECT 1 FROM outbox WHERE game_id=$1',[g.gameId]),r=>r.rowCount===0);
  });
  it('pauses during an API deployment, restores durable state, and resumes without redrawing',async()=>{
    const g=await readyGame();const before=(await a.games.read(g.gameId)).state;const rack=structuredClone(before.players.map(p=>p.rack));
    // All participants on the departing gateway move onto the surviving one.
    await a.close();const paused=await eventually(()=>b.games.read(g.gameId),r=>r.state.status==='paused');expect(paused.state.result).toBeNull();expect(paused.state.players.map(p=>p.rack)).toEqual(rack);expect(paused.state.clocksMs[before.activeSeat]).toBeGreaterThan(290000);
    const reconnected=await connect(urlB,g.p0);expect((await ack(reconnected,'game:subscribe',{gameId:g.gameId})).ok).toBe(true);const resumed=await eventually(()=>b.games.read(g.gameId),r=>r.state.status==='active'&&r.state.startsAt===null);expect(resumed.state.players.map(p=>p.rack)).toEqual(rack);expect(resumed.state.moves).toEqual(before.moves);
    a=await buildApp(config());urlA=await a.app.listen({host:'127.0.0.1',port:0});expect((await a.games.read(g.gameId)).state.board).toEqual(before.board);
  });
});
