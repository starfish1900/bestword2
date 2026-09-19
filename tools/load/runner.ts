import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { fork,type ChildProcess } from 'node:child_process';
import { readFile,writeFile,mkdir,readdir } from 'node:fs/promises';
import { createWriteStream,existsSync } from 'node:fs';
import { cpus,totalmem,freemem,platform,arch,release } from 'node:os';
import { performance,monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from 'redis';
import { io,type Socket } from 'socket.io-client';
import { Gaddag } from '@bestword/lexicon';
import { createGame,setConnected,startIfReady,applyAction,nextDeadline,assertStateInvariants,projectGame,type EngineState } from '@bestword/engine';
import type { GameAction,GameView,CommandReply,SyncReply,User,Seat,Letter,TileOrigin,PlacedTile,RecentMove } from '@bestword/contracts';
import { findMove } from '../testing/moves.js';
import { createDatabase,migrate } from '../../apps/server/dist/db.js';
import { Histogram,validateWireView } from './observations.js';

type Settings={games:number;spectators:number;commandsPerSecond:number;burst:number;burstEverySeconds:number;durationSeconds:number;apiInstances:number;workers:number;templates:number;syncIntervalSeconds:number};
type PrivatePrediction={racks:[Letter[],Letter[]];drawn:[number,number];tileOrigins:TileOrigin[];lastMoveTiles:PlacedTile[];recentMoves:RecentMove[];principalHistory:string[]};
type Template={initial:EngineState;actions:GameAction[];privateStates:PrivatePrediction[]};
type Child={process:ChildProcess;role:string;url?:string;epoch?:string;last?:any;peakRss:number;cpuCoreSeconds:number;log:string};
type Person={user:User;token:string;socket:Socket;gateway:Child};
type Table={index:number;id:string;knownGameIds:Set<string>;players:[Person,Person];spectators:Socket[];template:Template;view:GameView|null;busy:boolean;generation:number};
type Receipt={gameId:string;userId:string;commandId:string;revision:number};
type SyncMetadata={table:Table;seat:Seat|null;gameId:string;revision:number;nextAt:number;pending:boolean;lastPushRevision:number;lastPushMoveRevision:number;lastPushAt:number|null};
type Traffic={scheduled:number;offered:number;attempted:number;accepted:number;failed:number;skipped:number};
type Burst={at:number;requested:number;offered:number;accepted:number;failed:number};
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
process.chdir(root);
const presets=JSON.parse(await readFile('tools/load/scenarios.json','utf8')) as Record<string,Settings>;
const args=process.argv.slice(2);let scenario='smoke';const overrides:Partial<Settings>={};
const flags:Record<string,keyof Settings>={'--duration':'durationSeconds','--games':'games','--spectators':'spectators','--rate':'commandsPerSecond','--burst':'burst','--apis':'apiInstances','--workers':'workers','--sync':'syncIntervalSeconds'};
for(let i=0;i<args.length;i++){
  const key=args[i]!;
  if(key==='--help'){console.log('npm run test:load -- --scenario smoke|acceptance|scale [--duration seconds] [--games N] [--spectators N] [--rate N] [--burst N] [--apis N] [--workers N] [--sync seconds-or-0]\nUses only loopback PostgreSQL/Redis, generated isolated fixtures, and child API processes. Read tools/load/README.md.');process.exit(0);}
  const value=args[++i];if(value===undefined)throw new Error(`Missing value for ${key}`);
  if(key==='--scenario')scenario=value;else if(flags[key])overrides[flags[key]!]=Number(value);else throw new Error(`Unknown option ${key}`);
}
assert(presets[scenario],`Unknown scenario ${scenario}`);
const settings={...presets[scenario]!,...overrides};
for(const [key,value]of Object.entries(settings))assert(Number.isInteger(value)&&value>=(['spectators','workers','burst','syncIntervalSeconds'].includes(key)?0:1),`Invalid ${key}`);
assert(settings.games<=5000&&settings.spectators<=50000&&settings.apiInstances<=8&&settings.workers<=4&&settings.durationSeconds<=86400,'Test size is outside the bounded runner limits');
const sourceDatabase=process.env.BESTWORD_LOAD_DATABASE_URL??'postgresql://bestword:bestword-local@127.0.0.1:54329/bestword';
const sourceRedis=process.env.BESTWORD_LOAD_REDIS_URL??'redis://127.0.0.1:6389';
function requireLocal(url:string,protocols:string[]){const parsed=new URL(url);assert(protocols.includes(parsed.protocol)&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'Load tests refuse non-loopback URLs');assert(parsed.search===''&&parsed.hash==='','Load tests refuse connection query parameters or fragments');return parsed;}
const databaseBase=requireLocal(sourceDatabase,['postgresql:','postgres:']);
const redisBase=requireLocal(sourceRedis,['redis:']);
assert(databaseBase.pathname==='/bestword'&&decodeURIComponent(databaseBase.username)==='bestword','Use the designated local bestword fixture database/user');
assert((databaseBase.port||'5432')==='54329'&&(redisBase.port||'6379')==='6389','Load tests use the designated local service ports 54329/6389');
assert(redisBase.pathname===''||redisBase.pathname==='/'||redisBase.pathname==='/0','Redis input must name its base URL; the runner reserves a separate empty logical database');
const runId=randomUUID(),schema=`bw_load_${runId.replaceAll('-','')}`;
const reportDir=resolve('tools/load/reports');await mkdir(reportDir,{recursive:true});
const runName=`${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}-${scenario}`;
const reportPath=resolve(reportDir,`${runName}.json`),logDir=resolve('.local/load',runName);await mkdir(logDir,{recursive:true});
const admin=new pg.Pool({connectionString:sourceDatabase,max:2,connectionTimeoutMillis:5000});
const children:Child[]=[],sockets:Socket[]=[],tables:Table[]=[],receipts:Receipt[]=[];
const errors:Record<string,number>={},details:string[]=[],endToEnd:number[]=[],service:number[]=[],scheduleDelay:number[]=[],samples:any[]=[];
const bursts:Burst[]=[];
const traffic:Record<'baseline'|'burst',Traffic>={baseline:{scheduled:0,offered:0,attempted:0,accepted:0,failed:0,skipped:0},burst:{scheduled:0,offered:0,attempted:0,accepted:0,failed:0,skipped:0}};
const syncMetadata=new Map<Socket,SyncMetadata>(),pendingSyncs=new Set<Promise<void>>();
const syncLatencies:number[]=[];
const broadcastLatency=new Histogram();
let syncSerial=0,syncSent=0,syncUnchanged=0,syncChanged=0;
const actionMix:Record<string,number>={},loop=monitorEventLoopDelay({resolution:20});loop.enable();
let db:ReturnType<typeof createDatabase>|undefined,kv:ReturnType<typeof createClient>|undefined,redisDb=0,createdSchema=false,stopRequested=false,measuring=false;
let attempted=0,accepted=0,retries=0,duplicates=0,skippedBusy=0,cycles=0,updates=0,incomingBytes=0,disconnects=0,privacyFailures=0;
let measuredAt=0,finishedAt=0,nextTable=0,initialReady=0,actualDuration=0;
let measuredEndSockets:number|null=null;
let minConnectedSockets:number|null=null,minSampledSockets:number|null=null,offeredDurationSeconds=0,commandDrainSeconds=0,viewerDrainSeconds=0;
let viewerFreshness:any=null;
const retiredViewerFreshness={gamesChecked:0,viewerChecks:0,failures:0,maxDrainMs:0};
let phase='preparation',failurePhase:string|null=null,connectedNow=0,peakConnected=0,successfulConnections=0,connectionFailures=0;
let startupDisconnects=0;
const startupDisconnectReasons:Record<string,number>={};
const versions:Record<string,unknown>={};
let error:string|null=null,durable:any=null,cleanupError:string|null=null,reportTimer:NodeJS.Timeout|undefined,syncTimer:NodeJS.Timeout|undefined;
let pendingSample:Promise<void>|undefined;
let stopReason:string|null=null;
const processSamples=new Map<number,{peakRss:number;cpuCoreSeconds:number;samples:number;role:string;maxWaiting:number}>();
const progress=(message:string)=>console.log(`[${new Date().toISOString()}] ${message}`);
function failure(code:string,detail?:unknown){errors[code]=(errors[code]??0)+1;if(detail&&details.length<30)details.push(`${code}: ${String(detail)}`);}
function percentiles(values:number[]){if(!values.length)return {count:0,p50:null,p95:null,p99:null,max:null};const sorted=[...values].sort((a,b)=>a-b);const p=(n:number)=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*n)-1)]!;return {count:sorted.length,p50:p(.5),p95:p(.95),p99:p(.99),max:sorted.at(-1)};}
function report(status:string){
  const elapsed=offeredDurationSeconds||(measuredAt?(Date.now()-measuredAt)/1000:0);
  const ack=percentiles(endToEnd),processing=percentiles(service);
  const rate=elapsed?accepted/elapsed:0;
  const baselineRate=elapsed?traffic.baseline.accepted/elapsed:0;
  const requiredBursts=settings.burst?Math.max(0,Math.ceil(settings.durationSeconds/settings.burstEverySeconds)-1):0;
  const targetSockets=settings.games*2+settings.spectators;
  return {formatVersion:2,runId,scenario,settings,status,startedAt:new Date(measuredAt||Date.now()).toISOString(),finishedAt:finishedAt?new Date(finishedAt).toISOString():null,elapsedSeconds:elapsed,
    timing:{offeredLoadSeconds:offeredDurationSeconds||null,commandDrainSeconds,viewerDrainSeconds,totalMeasuredWallSeconds:actualDuration||null},
    hardware:{os:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),node:process.version},
    environment:{kind:'local shared hardware with separate API/worker and load-client processes',databaseHost:`${databaseBase.hostname}:${databaseBase.port}`,schema,redisDatabase:redisDb,versions,apiProcesses:children.filter(c=>c.role==='api').map(c=>({pid:c.process.pid,url:c.url})),logDirectory:logDir},
    startup:{phase,failurePhase,socketsAttempted:sockets.length,successfulConnections,connectionFailures,disconnects:startupDisconnects,disconnectReasons:startupDisconnectReasons,peakConnectedSockets:peakConnected,tablesCreated:tables.filter(Boolean).length,childProcesses:children.map(child=>({pid:child.process.pid,role:child.role,peakRssIncludingStartup:child.peakRss,latestSample:child.last?{rss:child.last.memory.rss,cpuCores:child.last.cpuCores,sockets:child.last.sockets,waiting:child.last.waiting}:null,exitCode:child.process.exitCode,signalCode:child.process.signalCode}))},
    workload:{initialReadySockets:initialReady,targetSockets,connectedAtMeasurementEnd:measuredEndSockets,minConnectedSockets,minSampledSockets,currentConnectedSockets:sockets.filter(s=>s.connected).length,attempted,accepted,duplicates,retries,completedGameCycles:cycles,skippedBusy,traffic,bursts,requiredBursts,acceptedPerSecond:rate,baselineAcceptedPerSecond:baselineRate,actionMix,gameUpdates:updates,revisionSync:{intervalSeconds:settings.syncIntervalSeconds,sent:syncSent,unchanged:syncUnchanged,changed:syncChanged},engineIoIncomingBytes:incomingBytes,engineIoIncomingAverageBytesPerSecond:elapsed?incomingBytes/elapsed:0,disconnects,privacyFailures},
    latencyMs:{endToEndAcknowledgement:ack,serviceCommandIncludingCommitAndPublish:processing,revisionSync:percentiles(syncLatencies),gameUpdateFromAcceptedMove:broadcastLatency.summary(),loadSchedulerLag:percentiles(scheduleDelay),loadClientEventLoopP99:loop.percentile(99)/1e6},
    resources:{children:[...processSamples.entries()].map(([pid,v])=>({pid,...v,averageCpuCores:elapsed?v.cpuCoreSeconds/elapsed:0})),driver:process.memoryUsage()},
    errors,details,durableVerification:durable,viewerFreshness,retiredViewerFreshness,samples,
    gate:{fullPreset:JSON.stringify(settings)===JSON.stringify(presets[scenario]),throughputTolerancePercent:5,durationMet:offeredDurationSeconds>=settings.durationSeconds-.1,socketTargetMet:initialReady===targetSockets&&measuredEndSockets===targetSockets&&minConnectedSockets===targetSockets&&minSampledSockets===targetSockets,baseRateMet:baselineRate>=settings.commandsPerSecond*.95,burstTargetMet:bursts.length===requiredBursts&&bursts.every(b=>b.offered===b.requested&&b.accepted===b.requested&&b.failed===0),processingP95Met:processing.p95!==null&&processing.p95<250,processingP99Met:processing.p99!==null&&processing.p99<750,noDisconnects:disconnects===0,noPrivacyFailure:privacyFailures===0,noApplicationErrors:Object.keys(errors).length===0,viewerFreshness:viewerFreshness?.passed===true&&retiredViewerFreshness.failures===0,durable:durable?.passed===true},
    limitations:['This is local hardware evidence, not Render capacity or a promise that US$100 supports the workload.','Accounts, sessions and deterministic starting fixtures are seeded directly; signup, login, lobby/admission and the initial countdown are excluded.','Full legal action sequences are precomputed using the engine and lexicon. Completed games are replaced by fresh active fixtures; replacement subscription/DB work remains inside measurement.','Service timing wraps Games.command through commit and publication. Authentication and transport add to the separately measured end-to-end acknowledgement.','The driver and local PostgreSQL/Redis share hardware with the child servers; CPU, network and storage contention affect results.','Engine.IO incoming byte counts are an application-level approximation, not a billable egress measurement.','A one-hour configured preset is not evidence of an executed one-hour run.'],stopReason,error,cleanupError};
}
async function save(status:string){await writeFile(reportPath,JSON.stringify(report(status),null,2)+'\n');}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopRequested=true;stopReason=signal;progress('Stopping after in-flight commands; preserving the report.');});

function seeded(seed:number){let n=seed|0;return (max:number)=>{n=(Math.imul(n,1664525)+1013904223)|0;return (n>>>0)%max;};}
async function makeTemplates(lexicon:Gaddag):Promise<Template[]>{
  const result:Template[]=[];
  for(let index=0;index<settings.templates;index++){
    let state=createGame({id:randomUUID(),players:[{id:randomUUID(),username:'FixtureA'},{id:randomUUID(),username:'FixtureB'}],minutes:25,lexiconVersion:lexicon.sha256,seedWords:lexicon.seedWords,now:1000,randomInt:seeded(715011+index)},lexicon);
    state=setConnected(state,0,true,1000);state=setConnected(state,1,true,1000);state=startIfReady(state,4000);
    const initial=structuredClone(state),actions:GameAction[]=[],privateStates:PrivatePrediction[]=[];
    const remember=()=>{const view=projectGame(state,null,state.lastTransitionAt).game;privateStates.push({racks:state.players.map(p=>[...p.rack]) as [Letter[],Letter[]],drawn:[...state.drawnThisTurn],tileOrigins:view.tileOrigins!,lastMoveTiles:view.lastMoveTiles!,recentMoves:view.recentMoves!,principalHistory:view.principalHistory});};remember();
    while(state.status!=='finished'&&actions.length<180){
      const canNoWords=state.drawnThisTurn[state.activeSeat]>0&&!state.players[state.activeSeat===0?1:0].passed;
      const action:GameAction=actions.length%5===0&&canNoWords?{type:'NO_WORDS'}:findMove(state,lexicon)??{type:canNoWords?'NO_WORDS':'PASS'};
      actions.push(action);state=applyAction(state,state.activeSeat,action,4000+actions.length*100,lexicon);assertStateInvariants(state);remember();
    }
    assert(state.status==='finished'&&state.result?.reason==='both-passed','Fixture sequence must finish with legal PASS actions');
    assert(actions.some(a=>a.type==='PLACE_WORD'),'Each fixture must include actual legal placements');
    result.push({initial,actions,privateStates});await delay(0);
  }
  progress(`Prepared ${result.length} deterministic full-game templates (${result.map(t=>t.actions.length).join(', ')} legal turns).`);return result;
}
async function launch(role:'api'|'worker'):Promise<Child>{
  const log=resolve(logDir,`${role}-${children.filter(c=>c.role===role).length}.log`),stream=createWriteStream(log);
  const parsed=new URL(sourceDatabase);parsed.searchParams.set('options',`-c search_path=${schema}`);
  const redisUrl=new URL(sourceRedis);redisUrl.pathname=`/${redisDb}`;
  const processChild=fork(resolve('tools/load/child.mjs'),[],{execPath:process.execPath,execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,NODE_ENV:'test',BESTWORD_LOAD_ROLE:role,DATABASE_URL:parsed.toString(),REDIS_URL:redisUrl.toString(),APP_ORIGIN:'http://127.0.0.1',HOST:'127.0.0.1',PORT:'3000',LEXICON_PATH:resolve('data/lexicon.bin.gz'),MAX_ACTIVE_GAMES:String(settings.games),MAX_SPECTATORS_PER_GAME:String(Math.max(10,Math.ceil(settings.spectators/settings.games))),DB_POOL_SIZE:role==='api'?'10':'5',WORKER_INTERVAL_MS:'250',LOG_LEVEL:'warn'}});
  const child:Child={process:processChild,role,peakRss:0,cpuCoreSeconds:0,log};children.push(child);processChild.stdout?.pipe(stream,{end:false});processChild.stderr?.pipe(stream,{end:false});processChild.once('exit',()=>stream.end());
  const ready=await new Promise<any>((resolveReady,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`${role} start timed out; see ${log}`)),60000);
    processChild.on('message',(message:any)=>{
      if(message.type==='ready'){clearTimeout(timer);resolveReady(message);}
      if(message.type==='sample'){
        child.last=message;child.peakRss=Math.max(child.peakRss,message.memory.rss);
        if(measuring){service.push(...message.commandDurations);const previous=processSamples.get(message.pid)??{peakRss:0,cpuCoreSeconds:0,samples:0,role,maxWaiting:0};previous.peakRss=Math.max(previous.peakRss,message.memory.rss);previous.cpuCoreSeconds+=message.cpuCores*message.intervalMs/1000;previous.samples++;previous.maxWaiting=Math.max(previous.maxWaiting,message.waiting??0);processSamples.set(message.pid,previous);}
      }
    });
    processChild.once('error',reject);processChild.once('exit',code=>{clearTimeout(timer);if(!stopRequested&&measuring)failure('SERVER_EXIT',`${role} ${code}`);reject(new Error(`${role} exited with ${code}; see ${log}`));});
  });
  if(ready.url)child.url=ready.url;if(ready.epoch)child.epoch=ready.epoch;return child;
}
function acceptView(table:Table,view:GameView,seat:Seat|null,socket?:Socket,isBroadcast=false){
  const moveCount=Number.isSafeInteger(view?.game?.moveCount)?view.game.moveCount!:-1;
  const predicted=table.template.privateStates[moveCount];
  const privacy=validateWireView(view,{seat,historyAccess:seat===null?'recent':'full',playerIds:table.players.map(p=>p.user.id) as [string,string],knownGame:table.knownGameIds.has(view?.game?.id),racks:predicted?.racks??[[],[]],drawn:predicted?.drawn??[0,0],moveCount,tileOrigins:predicted?.tileOrigins??[],lastMoveTiles:predicted?.lastMoveTiles??[],recentMoves:predicted?.recentMoves??[],principalHistory:predicted?.principalHistory??[]});
  if(!predicted)privacy.push('Unexpected fixture move count');
  if(privacy.length){privacyFailures++;failure('PRIVACY',privacy.join('; '));return;}
  if(view.game.id!==table.id)return;
  const tracked=socket?syncMetadata.get(socket):undefined;
  if(tracked&&tracked.gameId===view.game.id){
    tracked.revision=Math.max(tracked.revision,view.game.revision);
    if(isBroadcast){
      tracked.lastPushRevision=Math.max(tracked.lastPushRevision,view.game.revision);tracked.lastPushAt=Date.now();
      const move=view.game.recentMoves?.at(-1);
      if(measuring&&move&&move.revision>tracked.lastPushMoveRevision){broadcastLatency.add(Math.max(0,Date.now()-move.at));tracked.lastPushMoveRevision=move.revision;}
    }
  }
  if(!table.view||view.game.revision>=table.view.game.revision)table.view=view;
}
function trackSocket(socket:Socket,table:Table,seat:Seat|null){
  syncMetadata.set(socket,{table,seat,gameId:table.id,revision:0,nextAt:Date.now()+(++syncSerial*97)%(Math.max(1,settings.syncIntervalSeconds)*1000),pending:false,lastPushRevision:-1,lastPushMoveRevision:-1,lastPushAt:null});
}
async function sync(socket:Socket,metadata:SyncMetadata){
  const gameId=metadata.gameId,started=performance.now();metadata.pending=true;syncSent++;
  try{
    const reply=await socket.timeout(15000).emitWithAck('game:sync',{gameId,revision:metadata.revision}) as SyncReply;
    syncLatencies.push(performance.now()-started);
    if(!reply.ok){failure(`SYNC_${reply.error.code}`,reply.error.message);return;}
    if('unchanged' in reply){syncUnchanged++;return;}
    syncChanged++;acceptView(metadata.table,reply.view,metadata.seat,socket);
  }catch(caught){failure('SYNC_TRANSPORT',caught);}finally{metadata.pending=false;}
}
async function openSocket(gateway:Child,token?:string):Promise<Socket>{
  const socket=io(gateway.url!,{transports:['websocket'],forceNew:true,reconnection:false,timeout:30000,extraHeaders:{Origin:'http://127.0.0.1',...(token?{Cookie:`bw_session=${token}`}:{})}});sockets.push(socket);
  let counted=false;
  socket.io.engine?.on('packet',(packet:any)=>{if(measuring&&typeof packet.data==='string')incomingBytes+=Buffer.byteLength(packet.data)+1;});
  socket.on('disconnect',reason=>{if(counted){counted=false;connectedNow--;}if(measuring){minConnectedSockets=Math.min(minConnectedSockets??connectedNow,connectedNow);if(!stopRequested){disconnects++;failure('SOCKET_DISCONNECT',reason);}}else if(!stopRequested&&phase==='client-connections'){startupDisconnects++;startupDisconnectReasons[reason]=(startupDisconnectReasons[reason]??0)+1;failure('STARTUP_SOCKET_DISCONNECT',reason);}});
  await new Promise<void>((resolveConnected,reject)=>{
    socket.once('connect',()=>{counted=true;successfulConnections++;connectedNow++;peakConnected=Math.max(peakConnected,connectedNow);resolveConnected();});
    socket.once('connect_error',(caught:any)=>{
      connectionFailures++;
      const diagnostics:Record<string,unknown>={message:caught.message};
      for(const source of [caught,caught.cause,caught.description,caught.description?.error])if(source&&typeof source==='object')for(const key of ['code','syscall','address','port'])if(typeof source[key]==='string'||typeof source[key]==='number')diagnostics[key]=source[key];
      failure('SOCKET_CONNECT',JSON.stringify(diagnostics));reject(caught);
    });
  });return socket;
}
async function bounded<T>(items:T[],concurrency:number,fn:(item:T,index:number)=>Promise<void>){
  let index=0,failed=false,cause:unknown;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(index<items.length&&!failed){const current=index++;try{await fn(items[current]!,current);}catch(error){failed=true;cause??=error;}}
  }));
  if(failed)throw cause;
}
async function createFixture(table:Table){
  table.id=randomUUID();table.knownGameIds.add(table.id);table.view=null;const now=Number((await db!.pool.query('SELECT (extract(epoch from clock_timestamp())*1000)::bigint AS now')).rows[0].now);
  const state=structuredClone(table.template.initial);state.id=table.id;state.createdAt=now;state.lastTransitionAt=now;state.turnStartedAt=now;state.turnDeadlineAt=now+state.clocksMs[state.activeSeat];
  for(const seat of [0,1] as const)state.players[seat]={...state.players[seat],...table.players[seat].user};
  assertStateInvariants(state);
  const presence=kv!.multi();for(const seat of [0,1] as const)presence.zAdd(`bw:presence:${table.id}:${seat}`,{score:now+16000,value:`${table.players[seat].gateway.epoch}/${table.players[seat].socket.id}`}).pExpire(`bw:presence:${table.id}:${seat}`,45000);await presence.exec();
  const client=await db!.pool.connect();try{
    await client.query('BEGIN');
    await client.query('INSERT INTO games(id,state,revision,status,created_at,updated_at,next_deadline,gateways,next_check) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8)',[table.id,JSON.stringify(state),state.revision,state.status,now,nextDeadline(state),JSON.stringify(table.players.map(p=>[p.gateway.epoch])),now+5000]);
    for(const seat of [0,1] as const){await client.query('INSERT INTO game_players(game_id,user_id,seat) VALUES($1,$2,$3)',[table.id,table.players[seat].user.id,seat]);await client.query('INSERT INTO playing_slots(user_id,game_id) VALUES($1,$2)',[table.players[seat].user.id,table.id]);}
    await client.query("INSERT INTO game_events(game_id,revision,kind,at,public_data) VALUES($1,$2,'setup',$3,$4)",[table.id,state.revision,now,JSON.stringify({board:state.board,principalHistory:state.principalHistory})]);await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await Promise.all(table.players.map(async(person,seat)=>{trackSocket(person.socket,table,seat as Seat);const reply=await person.socket.timeout(30000).emitWithAck('game:subscribe',{gameId:table.id}) as CommandReply;assert(reply.ok,`Player subscription failed: ${JSON.stringify(reply)}`);if(reply.ok)acceptView(table,reply.view,seat as Seat,person.socket);}));
  await bounded(table.spectators,10,async socket=>{trackSocket(socket,table,null);const reply=await socket.timeout(30000).emitWithAck('game:subscribe',{gameId:table.id}) as CommandReply;assert(reply.ok,`Spectator subscription failed: ${JSON.stringify(reply)}`);if(reply.ok)acceptView(table,reply.view,null,socket);});
  table.generation++;
}
async function makeTable(index:number,templates:Template[],gateways:Child[]){
  assert(freemem()>=1024*1024*1024,'Local resource guard: less than 1 GiB of free host memory during connection setup');
  const people=[] as Person[];const now=Date.now();
  for(const seat of [0,1] as const){const user={id:randomUUID(),username:`L${runId.slice(0,5)}${index}S${seat}`},token=randomBytes(32).toString('hex');await db!.pool.query("INSERT INTO users(id,username,username_key,password_hash,created_at) VALUES($1,$2,$3,'load-fixture-no-login',$4)",[user.id,user.username,user.username.toLowerCase(),now]);await db!.pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[createHash('sha256').update(token).digest('hex'),user.id,now+(settings.durationSeconds+3600)*1000]);const gateway=gateways[(index+seat)%gateways.length]!;people.push({user,token,gateway,socket:await openSocket(gateway,token)});}
  const table:Table={index,id:'',knownGameIds:new Set(),players:people as [Person,Person],spectators:[],template:templates[index%templates.length]!,view:null,busy:true,generation:0};tables[index]=table;
  for(const seat of [0,1] as const)table.players[seat].socket.on('game:update',view=>{if(measuring)updates++;acceptView(table,view,seat,table.players[seat].socket,true);});
  const count=Math.floor(settings.spectators/settings.games)+(index<settings.spectators%settings.games?1:0);
  for(let i=0;i<count;i++){const socket=await openSocket(gateways[(index+i)%gateways.length]!);socket.on('game:update',view=>{if(measuring)updates++;acceptView(table,view,null,socket,true);});table.spectators.push(socket);}
  await createFixture(table);table.busy=false;
}
async function verifyRetiringViewers(table:Table,revision:number){
  const viewers=[...table.players.map(person=>person.socket),...table.spectators];
  const started=performance.now(),deadline=started+10000;
  const ready=()=>viewers.every(socket=>{const metadata=syncMetadata.get(socket);return socket.connected&&metadata?.gameId===table.id&&metadata.lastPushRevision>=revision;});
  while(!ready()&&performance.now()<deadline)await delay(5);
  retiredViewerFreshness.gamesChecked++;retiredViewerFreshness.viewerChecks+=viewers.length;retiredViewerFreshness.maxDrainMs=Math.max(retiredViewerFreshness.maxDrainMs,performance.now()-started);
  if(!ready()){retiredViewerFreshness.failures++;failure('RETIRED_VIEWERS_STALE',`${table.id} final revision ${revision}`);throw new Error('A retiring game did not reach every viewer through game:update');}
}
async function command(table:Table,scheduled:number,kind:'baseline'|'burst',burst?:Burst){
  table.busy=true;scheduleDelay.push(Math.max(0,performance.now()-scheduled));
  let successful=false;
  try{
    const current=table.view?.game;if(!current)throw new Error('Missing game view');
    if(current.status!=='active'||current.startsAt!==null){failure('GAME_NOT_ACTIVE',current.status);return;}
    const action=table.template.actions[current.moveCount!];assert(action,'Missing legal fixture action');
    const person=table.players[current.activeSeat],commandId=randomUUID(),payload={gameId:table.id,commandId,expectedRevision:current.revision,action};
    attempted++;traffic[kind].attempted++;const start=performance.now();let reply:CommandReply;
    try{reply=await person.socket.timeout(15000).emitWithAck('game:command',payload) as CommandReply;}catch{
      retries++;reply=await person.socket.timeout(15000).emitWithAck('game:command',payload) as CommandReply;
    }
    endToEnd.push(performance.now()-start);
    if(reply.view)acceptView(table,reply.view,current.activeSeat,person.socket);
    if(!reply.ok){failure(reply.error.code,reply.error.message);return;}
    assert(reply.acceptedRevision!==undefined,'Accepted response lacks revision');accepted++;traffic[kind].accepted++;if(burst)burst.accepted++;successful=true;actionMix[action.type]=(actionMix[action.type]??0)+1;receipts.push({gameId:table.id,userId:person.user.id,commandId,revision:reply.acceptedRevision});
    if(accepted%100===0){const duplicate=await person.socket.timeout(15000).emitWithAck('game:command',payload) as CommandReply;assert(duplicate.ok&&duplicate.acceptedRevision===reply.acceptedRevision,'Duplicate changed acceptance result');duplicates++;}
    if(reply.view.game.status==='finished'){
      assert(reply.view.game.result?.reason==='both-passed','Unexpected forfeit in healthy fixture');await verifyRetiringViewers(table,reply.view.game.revision);cycles++;await createFixture(table);
    }
  }catch(error){failure('DRIVER_COMMAND',error);}finally{if(!successful){traffic[kind].failed++;if(burst)burst.failed++;}table.busy=false;}
}
async function sample(){
  minSampledSockets=Math.min(minSampledSockets??connectedNow,connectedNow);
  const statuses=(await db!.pool.query('SELECT status,count(*)::int AS count FROM games GROUP BY status')).rows;
  const outbox=(await db!.pool.query('SELECT count(*)::int AS count,coalesce((extract(epoch from clock_timestamp())*1000)::bigint-min(created_at),0)::bigint AS oldest_ms FROM outbox')).rows[0];
  const deadlines=(await db!.pool.query("WITH clock AS (SELECT (extract(epoch from clock_timestamp())*1000)::bigint AS now) SELECT count(*) FILTER (WHERE next_check<=now)::int AS checks_due,coalesce(max(now-next_check) FILTER (WHERE next_check<=now),0)::float8 AS oldest_check_lag_ms,count(*) FILTER (WHERE next_deadline<=now)::int AS deadlines_due,coalesce(max(now-next_deadline) FILTER (WHERE next_deadline<=now),0)::float8 AS oldest_deadline_lag_ms FROM games CROSS JOIN clock WHERE status<>'finished'")).rows[0];
  const redisMemory=Object.fromEntries((await kv!.info('memory')).split('\r\n').filter(line=>/^(used_memory|used_memory_peak|used_memory_rss|maxmemory):/.test(line)).map(line=>{const [key,value]=line.split(':');return [key,Number(value)];}));
  if((redisMemory.used_memory??0)>=100000000){stopReason='Shared local Redis reached the 100 MB safety threshold';stopRequested=true;failure('RESOURCE_GUARD',stopReason);}
  const hostFreeMemoryBytes=freemem();if(hostFreeMemoryBytes<1024*1024*1024){stopReason='Local host has less than 1 GiB of free memory';stopRequested=true;failure('RESOURCE_GUARD',stopReason);}
  samples.push({at:Date.now(),elapsedSeconds:(Date.now()-measuredAt)/1000,accepted,attempted,statuses,outbox,deadlines,redisMemory,hostFreeMemoryBytes,connected:sockets.filter(s=>s.connected).length,driverRss:process.memoryUsage().rss,children:children.map(c=>({pid:c.process.pid,role:c.role,rss:c.last?.memory.rss,cpuCores:c.last?.cpuCores,sockets:c.last?.sockets,waiting:c.last?.waiting}))});
  await save('running');progress(`${accepted} accepted; ${sockets.filter(s=>s.connected).length} sockets; ${Object.values(errors).reduce((a,b)=>a+b,0)} errors; ${(Date.now()-measuredAt)/1000|0}s measured.`);
}
async function verifyViewers(){
  const rows=(await db!.pool.query("SELECT id,revision,jsonb_array_length(state->'moves') AS moves FROM games WHERE id=ANY($1::uuid[])",[tables.map(t=>t.id)])).rows;
  const targets=new Map<string,{revision:number;moves:number}>(rows.map(row=>[row.id,{revision:row.revision,moves:row.moves}]));
  const deadline=performance.now()+10000;let stale:any[]=[];let broadcastViewers=0,initializationViewers=0,confirmed=0;
  do{
    stale=[];broadcastViewers=0;initializationViewers=0;confirmed=0;
    for(const [socket,metadata]of syncMetadata){
      const target=targets.get(metadata.table.id);if(!target)throw new Error('Missing final game target');
      if(target.moves>0)broadcastViewers++;else initializationViewers++;
      const revision=target.moves>0?metadata.lastPushRevision:metadata.revision;
      if(socket.connected&&metadata.gameId===metadata.table.id&&revision>=target.revision)confirmed++;
      else if(stale.length<20)stale.push({gameId:metadata.table.id,seat:metadata.seat,requiredRevision:target.revision,observedPushRevision:metadata.lastPushRevision,initializationOnly:target.moves===0,lastPushAt:metadata.lastPushAt,connected:socket.connected});
    }
    if(confirmed===syncMetadata.size)break;
    await delay(100);
  }while(performance.now()<deadline);
  const passed=confirmed===syncMetadata.size&&syncMetadata.size===settings.games*2+settings.spectators;
  if(!passed)failure('VIEWERS_STALE',`${confirmed}/${syncMetadata.size} viewers converged`);
  return {passed,timeoutMs:10000,expectedViewers:syncMetadata.size,confirmedViewers:confirmed,broadcastViewers,initializationOnlyViewers:initializationViewers,staleExamples:stale,acknowledgementsCountAsBroadcast:false};
}
async function verifyDurable(){
  durable={passed:false,phase:'receipts',acknowledgedReceiptsChecked:0,successfulReceipts:0,snapshotMoves:0,gameInvariantsChecked:0};
  let checked=0;
  for(let offset=0;offset<receipts.length;offset+=1000){const group=receipts.slice(offset,offset+1000);const rows=(await db!.pool.query('SELECT game_id,user_id,command_id,reply FROM commands WHERE command_id=ANY($1::uuid[])',[group.map(r=>r.commandId)])).rows;const map=new Map(rows.map(row=>[row.command_id,row]));for(const receipt of group){const found=map.get(receipt.commandId);assert(found&&found.game_id===receipt.gameId&&found.user_id===receipt.userId&&found.reply.ok===true&&found.reply.revision===receipt.revision,'Acknowledged command receipt missing or changed');checked++;}}
  durable.acknowledgedReceiptsChecked=checked;
  const success=Number((await db!.pool.query("SELECT count(*) AS count FROM commands WHERE reply->>'ok'='true'")).rows[0].count);assert.equal(success,receipts.length,'Successful commands applied more than once');durable.successfulReceipts=success;durable.phase='invariants';
  let gamesChecked=0;let cursor='00000000-0000-0000-0000-000000000000';
  while(true){const rows=(await db!.pool.query('SELECT id,state FROM games WHERE id>$1 ORDER BY id LIMIT 200',[cursor])).rows;if(!rows.length)break;for(const row of rows){assertStateInvariants(row.state);assert(!row.state.result||row.state.result.reason==='both-passed',`Unexpected game result: ${row.state.result?.reason}`);gamesChecked++;durable.gameInvariantsChecked=gamesChecked;}cursor=rows.at(-1).id;}
  const actualMoves=Number((await db!.pool.query('SELECT coalesce(sum(jsonb_array_length(state->\'moves\')),0) AS count FROM games')).rows[0].count);assert.equal(actualMoves,accepted,'Snapshot move count differs from accepted commands');
  return {passed:true,acknowledgedReceiptsChecked:checked,successfulReceipts:success,snapshotMoves:actualMoves,gameInvariantsChecked:gamesChecked};
}

try{
  await admin.query('SELECT 1');
  for(let candidate=15;candidate>=1;candidate--){const url=new URL(sourceRedis);url.pathname=`/${candidate}`;const test=createClient({url:url.toString(),socket:{connectTimeout:5000},disableOfflineQueue:true});test.on('error',()=>{});await test.connect();const claimed=Number(await test.eval("if redis.call('DBSIZE')==0 then redis.call('SET',KEYS[1],ARGV[1]);return 1 end;return 0",{keys:['bw:load-owner'],arguments:[runId]}));if(claimed){kv=test;redisDb=candidate;break;}await test.close();}
  assert(kv,'No empty nonzero Redis database is available; no data was cleared');
  versions.postgresql=(await admin.query('SELECT version() AS version')).rows[0].version;
  versions.redisServer=(await kv.info('server')).split('\r\n').filter(line=>/^(redis_version|redis_mode|os|valkey_version):/.test(line));
  versions.redisMaxmemory=await kv.configGet('maxmemory');
  versions.serverGamesSha256=createHash('sha256').update(await readFile('apps/server/dist/games.js')).digest('hex');
  const compiledArtifacts:Record<string,string>={};
  for(const directory of ['apps/server/dist','packages/contracts/dist','packages/engine/dist','packages/lexicon/dist'])for(const filename of (await readdir(directory)).filter(name=>name.endsWith('.js')).sort()){
    const path=`${directory}/${filename}`;compiledArtifacts[path]=createHash('sha256').update(await readFile(path)).digest('hex');
  }
  versions.compiledArtifacts=compiledArtifacts;
  versions.compiledCombinedSha256=createHash('sha256').update(JSON.stringify(compiledArtifacts)).digest('hex');
  versions.packageLockSha256=createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  const harnessArtifacts:Record<string,string>={};
  for(const path of ['tools/load/run.mjs','tools/load/runner.ts','tools/load/child.mjs','tools/load/scenarios.json','tools/load/observations.ts','tools/testing/moves.ts'])harnessArtifacts[path]=createHash('sha256').update(await readFile(path)).digest('hex');
  versions.harnessArtifacts=harnessArtifacts;
  versions.harnessCombinedSha256=createHash('sha256').update(JSON.stringify(harnessArtifacts)).digest('hex');
  versions.lexiconArtifactSha256=createHash('sha256').update(await readFile('data/lexicon.bin.gz')).digest('hex');
  await admin.query(`CREATE SCHEMA "${schema}"`);createdSchema=true;const url=new URL(sourceDatabase);url.searchParams.set('options',`-c search_path=${schema}`);db=createDatabase(url.toString(),4);await migrate(db);
  const lexicon=await Gaddag.open('data/lexicon.bin.gz');const templates=await makeTemplates(lexicon);
  phase='server-startup';
  for(let i=0;i<settings.apiInstances;i++)await launch('api');for(let i=0;i<settings.workers;i++)await launch('worker');
  const gateways=children.filter(child=>child.role==='api');progress(`Started ${gateways.length} API processes and ${settings.workers} worker; local schema ${schema}; Redis database ${redisDb}.`);
  phase='client-connections';await bounded(Array.from({length:settings.games},(_,i)=>i),8,index=>makeTable(index,templates,gateways));
  await delay(1000);initialReady=connectedNow;assert.equal(initialReady,settings.games*2+settings.spectators);
  phase='measurement';measuredAt=Date.now();measuring=true;minConnectedSockets=connectedNow;minSampledSockets=connectedNow;for(const child of children)child.process.send('measure');loop.reset();progress(`Measurement started: ${settings.games} games, ${settings.spectators} spectators, ${settings.commandsPerSecond} commands/s for ${settings.durationSeconds}s.`);
  if(settings.syncIntervalSeconds){
    for(const metadata of syncMetadata.values())metadata.nextAt=measuredAt+(++syncSerial*97)%(settings.syncIntervalSeconds*1000);
    syncTimer=setInterval(()=>{const now=Date.now();for(const [socket,metadata]of syncMetadata){
      if(metadata.pending||metadata.table.busy||!socket.connected||metadata.nextAt>now)continue;
      metadata.nextAt=now+settings.syncIntervalSeconds*1000;const pending=sync(socket,metadata);pendingSyncs.add(pending);void pending.finally(()=>pendingSyncs.delete(pending));
    }},100);
  }
  reportTimer=setInterval(()=>{if(!pendingSample){pendingSample=sample().catch(error=>failure('REPORT',error)).finally(()=>{pendingSample=undefined;});}},15000);
  await save('running');const start=performance.now(),until=start+settings.durationSeconds*1000,spacing=1000/settings.commandsPerSecond;let next=start,nextBurst=start+settings.burstEverySeconds*1000;
  const inFlight=new Set<Promise<void>>();let nextControl=start;
  const dispatch=(at:number,kind:'baseline'|'burst',burst?:Burst)=>{traffic[kind].scheduled++;let selected:Table|undefined;for(let search=0;search<tables.length;search++){const candidate=tables[nextTable++%tables.length]!;if(!candidate.busy&&candidate.players.every(p=>p.socket.connected)){selected=candidate;break;}}if(!selected){skippedBusy++;traffic[kind].skipped++;return false;}traffic[kind].offered++;const pending=command(selected,at,kind,burst);inFlight.add(pending);void pending.finally(()=>inFlight.delete(pending));return true;};
  while(performance.now()<until&&!stopRequested){
    if(performance.now()>=nextControl){nextControl=performance.now()+1000;if(existsSync(resolve(logDir,'STOP'))){stopRequested=true;stopReason='Operator STOP file';break;}}
    if(performance.now()>=nextBurst&&nextBurst<until-.01&&settings.burst){
      await Promise.allSettled([...inFlight]);
      if(existsSync(resolve(logDir,'STOP'))){stopRequested=true;stopReason='Operator STOP file';}
      if(performance.now()>=until||stopRequested)break;
      const at=performance.now();const burst:Burst={at:Date.now(),requested:settings.burst,offered:0,accepted:0,failed:0};bursts.push(burst);for(let i=0;i<settings.burst&&performance.now()<until&&!stopRequested;i++)if(dispatch(at,'burst',burst))burst.offered++;nextBurst+=settings.burstEverySeconds*1000;
    }
    if(performance.now()>=until||stopRequested)break;
    const now=performance.now();let issued=0;while(next<=now&&next<until&&issued<settings.games&&performance.now()<until&&!stopRequested){dispatch(next,'baseline');next+=spacing;issued++;}await delay(Math.max(1,Math.min(10,next-performance.now())));
  }
  const offeringEndedAt=Math.min(performance.now(),until);offeredDurationSeconds=(offeringEndedAt-start)/1000;const drainStarted=offeringEndedAt;
  if(syncTimer)clearInterval(syncTimer);await Promise.allSettled([...inFlight,...pendingSyncs]);commandDrainSeconds=(performance.now()-drainStarted)/1000;
  phase='viewer-verification';const viewersStarted=performance.now();viewerFreshness=await verifyViewers();viewerDrainSeconds=(performance.now()-viewersStarted)/1000;
  finishedAt=Date.now();measuredEndSockets=connectedNow;actualDuration=(finishedAt-measuredAt)/1000;clearInterval(reportTimer);await pendingSample;await delay(1100);await sample();phase='durable-verification';durable=await verifyDurable();measuring=false;phase='complete';
}catch(caught){failurePhase=phase;measuredEndSockets??=connectedNow;error=caught instanceof Error?caught.stack??caught.message:String(caught);progress(`Run failed during ${phase}: ${String(caught)}`);process.exitCode=1;}
finally{
  if(reportTimer)clearInterval(reportTimer);if(syncTimer)clearInterval(syncTimer);measuring=false;stopRequested=true;loop.disable();
  await pendingSample;
  await save(error?'failed':'completed');
  await Promise.allSettled(children.map(async child=>{if(child.process.exitCode!==null)return;const done=new Promise<void>(resolveExit=>child.process.once('exit',()=>resolveExit()));child.process.send('stop');await Promise.race([done,delay(20000,undefined,{ref:false})]);if(child.process.exitCode===null)child.process.kill('SIGKILL');await Promise.race([done,delay(5000,undefined,{ref:false})]);}));
  for(const socket of sockets)socket.disconnect();
  const cleanupErrors:string[]=[];
  for(const child of children)if(child.process.exitCode!==0)cleanupErrors.push(`${child.role} child ${child.process.pid} stopped with exit ${child.process.exitCode}, signal ${child.process.signalCode}`);
  try{if(db)await db.pool.end();}catch(caught){cleanupErrors.push(String(caught));}
  try{if(createdSchema){assert(/^bw_load_[a-f0-9]{32}$/.test(schema));await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}}catch(caught){cleanupErrors.push(String(caught));}
  try{if(kv){assert.equal(await kv.get('bw:load-owner'),runId,'Redis ownership changed; refusing cleanup');const keys:string[]=[];for await(const batch of kv.scanIterator({MATCH:'bw:*',COUNT:1000}))keys.push(...batch);for(let offset=0;offset<keys.length;offset+=500)await kv.unlink(keys.slice(offset,offset+500));}}catch(caught){cleanupErrors.push(String(caught));}
  finally{if(kv?.isOpen)kv.destroy();}
  if(cleanupErrors.length){cleanupError=cleanupErrors.join('; ');process.exitCode=1;}
  await admin.end();await save(error?'failed':stopRequested&&actualDuration<settings.durationSeconds-.5?'interrupted':'completed');
  progress(`Report saved: ${reportPath}`);
  const failedGates=Object.entries(report('completed').gate).filter(([key,value])=>key!=='fullPreset'&&typeof value==='boolean'&&!value).map(([key])=>key);
  if(failedGates.length){progress(`Failed operational gates: ${failedGates.join(', ')}`);process.exitCode=1;}
}
