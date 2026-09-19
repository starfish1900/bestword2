/** Real local HTTP/socket/PG/Redis mixed AI soak. Never uses external services. */
import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir,writeFile,readFile,readdir } from 'node:fs/promises';
import { createWriteStream,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus,totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from 'redis';
import { io,type Socket } from 'socket.io-client';
import { Gaddag } from '@bestword/lexicon';
import { assertStateInvariants,type EngineState } from '@bestword/engine';
import { createDatabase,migrate } from '../../apps/server/dist/db.js';
import { findMove } from '../testing/moves.js';
const games=Number(process.argv[2]??1),duration=Number(process.argv[3]??120);
assert(Number.isInteger(games)&&games>=1&&games<=10&&Number.isInteger(duration)&&duration>=10&&duration<=7200);
const runId=randomUUID(),schema=`bw_ai_load_${runId.replaceAll('-','')}`;
const base='postgresql://bestword:bestword-local@127.0.0.1:54329/bestword',redisBase='redis://127.0.0.1:6389';
const directory=resolve('tools/ai-load/reports',`${new Date().toISOString().replaceAll(':','-')}-${games}games`);
await mkdir(directory,{recursive:true});
const admin=new pg.Pool({connectionString:base,max:2});
let db:ReturnType<typeof createDatabase>|undefined,kv:ReturnType<typeof createClient>|undefined,redisDb=0,created=false,stopped=false,started=0;
const children:{process:ChildProcess;role:string;peakRss:number;samples:any[]}[]=[],sockets:Socket[]=[],service:number[]=[],ackTimes:number[]=[],errors:string[]=[];
let completedCycles=0,humanCommands=0,jobResults:any[]=[],finalStates:EngineState[]=[],phase='preparing',url='',durableVerified=false,measuredDurationMs=0,disconnects=0,singleCpuAffinity=false;
const samples:any[]=[];
type Person={id:string;username:string;token:string;socket:Socket};
type Table={id:string;people:Person[];difficulty?:string;lastAction:number};
const tables:Table[]=[];
function percentile(values:number[],p:number){const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;}
function report(){const turns=jobResults.filter(j=>j.status==='completed'),latencies=turns.map(j=>Number(j.updated_at)-Number(j.created_at));const ai=children.find(c=>c.role==='ai');return {
  runId,phase,games,durationSeconds:duration,elapsedSeconds:measuredDurationMs?measuredDurationMs/1000:started?(Date.now()-started)/1000:0,schema,redisDb,completedCycles,humanCommands,disconnects,
  environment:{kind:'local shared hardware, separate API and AI processes, one AI search thread',singleCpuAffinity,node:process.version,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemory:totalmem()},
  aiTurns:{count:turns.length,within5Seconds:latencies.length?latencies.filter(v=>v<5000).length/latencies.length:null,p50:percentile(latencies,.5),p95:percentile(latencies,.95),p99:percentile(latencies,.99),max:latencies.length?Math.max(...latencies):null,strategicWaits:turns.filter(j=>j.result?.strategy?.reason==='strategic-no-words').length,incomplete:turns.filter(j=>j.result?.complete!==true).length,retries:jobResults.filter(j=>j.attempts>1).length},
  api:{serviceP95:percentile(service,.95),serviceP99:percentile(service,.99),ackP95:percentile(ackTimes,.95),count:service.length},
  processes:children.map(c=>({role:c.role,pid:c.process.pid,exitCode:c.process.exitCode,signalCode:c.process.signalCode,peakRss:c.peakRss,samples:c.samples})),samples,errors,
  gate:{durationMet:measuredDurationMs>=duration*1000,turnsSampled:turns.length>=20,ai95Within5Seconds:latencies.length>0&&latencies.filter(v=>v<5000).length/latencies.length>=.95,noStalledAiTurnsAtEnd:jobResults.every(j=>j.status==='completed'||started+measuredDurationMs-Number(j.created_at)<5000),memoryBelow70Percent2GiB:!!ai&&ai.peakRss<.7*2*1024**3,apiLatencyMet:service.length>0&&percentile(service,.95)!<250&&percentile(service,.99)!<750,noErrors:errors.length===0,noDisconnects:disconnects===0,noUnexpectedForfeits:finalStates.every(s=>!s.result||s.result.reason==='both-passed'),noDuplicateAcceptedTurns:durableVerified,allFinalStatesValid:finalStates.length>0,cleanProcessExits:children.every(c=>c.process.exitCode===0)},
  limitations:['Local shared hardware and single logical CPU affinity on Windows do not establish Render capacity or equivalent cloud CPU speed.','Accounts are fixture-seeded. Games use real admission, countdown, presence, clocks, commands and durable jobs.','Humans use a bounded legal-move helper and fast 1.5-second minimum think time. One human-versus-human table runs alongside AI tables.','Healthy soak only; fault/recovery semantics are covered by separate integration tests.','Memory samples include worker threads through process RSS; stable memory requires reviewing the saved time series.']};}
async function save(){await writeFile(resolve(directory,'report.json'),JSON.stringify(report(),null,2)+'\n');}
async function launch(role:string){const stream=createWriteStream(resolve(directory,`${role}.log`));const child=fork(resolve('tools/ai-load/child.mjs'),[],{execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,NODE_ENV:'test',BESTWORD_LOAD_ROLE:role,DATABASE_URL:`${base}?options=${encodeURIComponent(`-c search_path=${schema}`)}`,REDIS_URL:`${redisBase}/${redisDb}`,APP_ORIGIN:'http://127.0.0.1',HOST:'127.0.0.1',LEXICON_PATH:resolve('data/lexicon.bin.gz'),EASY_LEXICON_PATH:resolve('data/easy.gaddag'),MEDIUM_LEXICON_PATH:resolve('data/medium.gaddag'),AI_MAX_GAMES:String(games),MAX_ACTIVE_GAMES:'30',AI_WORKERS:'1',AI_LOOKAHEAD_MS:'1500',LOG_LEVEL:'warn',WORKER_INTERVAL_MS:'100'}});
  const info={process:child,role,peakRss:0,samples:[] as any[]};children.push(info);child.stdout!.pipe(stream,{end:false});child.stderr!.pipe(stream,{end:false});child.once('exit',()=>stream.end());
  return new Promise<any>((res,rej)=>{const timeout=setTimeout(()=>rej(new Error(`${role} startup timeout`)),60000);child.on('message',(m:any)=>{if(m.type==='ready'){clearTimeout(timeout);res(m);}if(m.type==='sample'){info.peakRss=Math.max(info.peakRss,m.rss);service.push(...m.durations);if(info.samples.length===0||m.at-info.samples.at(-1).at>=10000)info.samples.push({at:m.at,rss:m.rss,cpuCores:m.cpuCores});}});child.once('error',rej);child.once('exit',code=>{clearTimeout(timeout);if(!stopped){errors.push(`${role} exited ${code}`);stopped=true;}rej(new Error(`${role} exited ${code}`));});});}
async function person(index:number):Promise<Person>{const id=randomUUID(),username=`Soak${index}`,token=randomBytes(32).toString('hex');await db!.pool.query("INSERT INTO users(id,username,username_key,password_hash,created_at) VALUES($1,$2,$3,'!fixture!',0)",[id,username,username.toLowerCase()]);await db!.pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[createHash('sha256').update(token).digest('hex'),id,Date.now()+(duration+3600)*1000]);const socket=io(url,{forceNew:true,transports:['websocket'],reconnection:false,extraHeaders:{Origin:'http://127.0.0.1',Cookie:`bw_session=${token}`}});sockets.push(socket);await new Promise<void>((res,rej)=>{socket.once('connect',()=>res());socket.once('connect_error',rej);});return {id,username,token,socket};}
async function post(path:string,person:Person,body:unknown){const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1',Cookie:`bw_session=${person.token}`},body:JSON.stringify(body)});const result=await r.json();assert(r.ok,`${path}: ${JSON.stringify(result)}`);return result as any;}
async function newGame(table:Table){if(table.difficulty)table.id=(await post('/api/games/ai',table.people[0]!,{difficulty:table.difficulty,minutes:25})).gameId;else{const seek=await post('/api/seeks',table.people[0]!,{minutes:25});table.id=(await post(`/api/seeks/${seek.seek.id}/join`,table.people[1]!,{})).gameId;}for(const p of table.people){const r=await p.socket.timeout(10000).emitWithAck('game:subscribe',{gameId:table.id});assert(r.ok,JSON.stringify(r));}table.lastAction=Date.now();}
process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
try{
  await admin.query(`CREATE SCHEMA "${schema}"`);created=true;db=createDatabase(`${base}?options=${encodeURIComponent(`-c search_path=${schema}`)}`);await migrate(db);
  for(let candidate=15;candidate>=1;candidate--){const test=createClient({url:`${redisBase}/${candidate}`});test.on('error',()=>{});await test.connect();if(Number(await test.eval("if redis.call('DBSIZE')==0 then redis.call('SET',KEYS[1],ARGV[1]);return 1 end;return 0",{keys:['bw:ai-load-owner'],arguments:[runId]}))){kv=test;redisDb=candidate;break;}await test.close();}assert(kv,'No empty nonzero Redis database available');
  async function compiledFiles(folder:string):Promise<string[]>{const entries=await readdir(folder,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?compiledFiles(`${folder}/${e.name}`):Promise.resolve(e.name.endsWith('.js')?[`${folder}/${e.name}`]:[])))).flat();}
  const artifacts=['package-lock.json','tools/ai-load/run.ts','tools/ai-load/child.mjs','tools/testing/moves.ts','data/lexicon.bin.gz','data/easy.gaddag','data/medium.gaddag',...(await Promise.all(['apps/server/dist','packages/ai/dist','packages/engine/dist','packages/contracts/dist','packages/lexicon/dist'].map(compiledFiles))).flat()];
  await writeFile(resolve(directory,'artifact-hashes.json'),JSON.stringify(Object.fromEntries(await Promise.all(artifacts.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')]))),null,2));
  url=(await launch('api')).url;singleCpuAffinity=(await launch('ai')).singleCpuAffinity===true;const full=await Gaddag.open('data/lexicon.bin.gz');
  for(let i=0;i<games;i++){const difficulty=games===1?'hard':['hard','easy','medium'][i%3]!;const table={id:'',people:[await person(i)],difficulty,lastAction:0};await newGame(table);tables.push(table);}
  const humanTable={id:'',people:[await person(games),await person(games+1)],lastAction:0};await newGame(humanTable);tables.push(humanTable);
  for(const socket of sockets)socket.on('disconnect',()=>{if(phase==='running'&&!stopped)disconnects++;});
  phase='running';started=Date.now();let nextSample=0;console.log(`Started ${games} AI games plus 1 human table for ${duration}s. Report: ${directory}`);
  while(!stopped&&Date.now()-started<duration*1000){
    if(existsSync(resolve(directory,'STOP'))){stopped=true;break;}
    const rows=(await db.pool.query('SELECT state FROM games WHERE id=ANY($1::uuid[])',[tables.map(t=>t.id)])).rows;
    for(const table of tables){const state=rows.find(r=>r.state.id===table.id)?.state as EngineState|undefined;if(!state)continue;
      assertStateInvariants(state);
      if(state.status==='finished'){completedCycles++;await newGame(table);continue;}
      if(state.status!=='active'||state.turnStartedAt===null||Date.now()-table.lastAction<1500||(state.ai&&state.activeSeat===state.ai.seat))continue;
      const player=table.people.find(p=>p.id===state.players[state.activeSeat].id);assert(player);
      const noWords=state.drawnThisTurn[state.activeSeat]>0&&!state.players[state.activeSeat===0?1:0].passed;
      const action=state.moves.length%7===0&&noWords?{type:'NO_WORDS'}:findMove(state,full)??{type:noWords?'NO_WORDS':'PASS'};
      const begin=performance.now();const reply=await player.socket.timeout(15000).emitWithAck('game:command',{gameId:state.id,commandId:randomUUID(),expectedRevision:state.revision,action});ackTimes.push(performance.now()-begin);
      if(!reply.ok){if(reply.error?.code!=='STALE_REVISION')throw new Error(JSON.stringify(reply));}else humanCommands++;table.lastAction=Date.now();
    }
    if(Date.now()>=nextSample){nextSample=Date.now()+15000;jobResults=(await db.pool.query('SELECT * FROM ai_jobs')).rows;const pending=jobResults.filter(j=>j.status==='queued'||j.status==='running');samples.push({at:Date.now(),jobs:jobResults.length,completed:jobResults.filter(j=>j.status==='completed').length,pending:pending.length,oldestPendingAgeMs:pending.length?Math.max(...pending.map(j=>Date.now()-Number(j.created_at))):0,activeGames:tables.length});await save();console.log(`${Math.round((Date.now()-started)/1000)}s: ${jobResults.filter(j=>j.status==='completed').length} AI turns, ${humanCommands} human turns`);}
    await delay(100);
  }
  measuredDurationMs=Date.now()-started;const requestedStop=stopped;stopped=true;
  const aiChild=children.find(c=>c.role==='ai')!.process;
  if(aiChild.connected){aiChild.send('stop');await new Promise<void>((res,rej)=>{const t=setTimeout(()=>rej(new Error('AI shutdown timed out before durable verification')),15000);aiChild.once('exit',()=>{clearTimeout(t);res();});});}
  jobResults=(await db.pool.query('SELECT * FROM ai_jobs')).rows;finalStates=(await db.pool.query('SELECT state FROM games')).rows.map(r=>r.state);for(const state of finalStates)assertStateInvariants(state);
  await writeFile(resolve(directory,'jobs.json'),JSON.stringify(jobResults,null,2));
  for(const state of finalStates){if(!state.ai)continue;const accepted=jobResults.filter(j=>j.game_id===state.id&&j.status==='completed');const moves=state.moves.filter(m=>m.seat===state.ai!.seat);assert.equal(accepted.length,moves.length,'AI move/job count mismatch');for(const job of accepted){const move=state.moves[job.turn_number];assert(move&&move.seat===state.ai.seat&&move.revision===job.result.acceptedRevision,'AI job does not match exactly one accepted turn');assert.equal(job.result.complete,true);assert.equal(move.action,job.result.action.type);}const receipts=(await db.pool.query('SELECT count(*) AS count FROM commands WHERE game_id=$1 AND user_id=$2',[state.id,state.players[state.ai.seat].id])).rows[0];assert.equal(Number(receipts.count),accepted.length,'AI receipt count mismatch');}durableVerified=true;
  phase=requestedStop?'stopped':'completed';
}catch(error){errors.push(String(error));phase='failed';console.error(error);process.exitCode=1;}
finally{
  stopped=true;for(const socket of sockets)socket.disconnect();for(const child of children)if(child.process.connected)child.process.send('stop');
  try{
    await Promise.all(children.map(c=>new Promise<void>((res,rej)=>{if(c.process.exitCode!==null||c.process.signalCode!==null)return res();let hardTimer:NodeJS.Timeout|undefined;const t=setTimeout(()=>{errors.push(`${c.role} required forced shutdown`);c.process.kill();hardTimer=setTimeout(()=>rej(new Error(`${c.role} did not exit; preserving fixtures`)),5000);},15000);c.process.once('exit',()=>{clearTimeout(t);if(hardTimer)clearTimeout(hardTimer);res();});})));
    await db?.pool.end();if(created)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
    if(kv){assert.equal(await kv.get('bw:ai-load-owner'),runId);const keys:string[]=[];for await(const batch of kv.scanIterator({MATCH:'bw:*',COUNT:1000}))keys.push(...batch);for(let i=0;i<keys.length;i+=500)await kv.unlink(keys.slice(i,i+500));await kv.close();}
  }catch(error){errors.push(`Cleanup failed: ${String(error)}`);phase='failed';process.exitCode=1;}
  await save();console.log(JSON.stringify(report().gate));if(phase!=='completed'||Object.values(report().gate).some(value=>!value))process.exitCode=1;
}


