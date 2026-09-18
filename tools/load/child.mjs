// Test process wrapper: production API/worker implementation, local-only IPC metrics.
import { performance } from 'node:perf_hooks';
import { buildApp } from '../../apps/server/dist/app.js';
import { readConfig } from '../../apps/server/dist/config.js';

const role=process.env.BESTWORD_LOAD_ROLE;
let runtime;
let durations=[];
let measuring=false;
let lastCpu=process.cpuUsage();
let lastWall=performance.now();
if(role==='api'){
  runtime=await buildApp(readConfig());
  const command=runtime.games.command.bind(runtime.games);
  runtime.games.command=async(...args)=>{
    const start=performance.now();
    try{return await command(...args);}finally{if(measuring)durations.push(performance.now()-start);}
  };
  const url=await runtime.app.listen({host:'127.0.0.1',port:0});
  process.send?.({type:'ready',role,url,epoch:runtime.health.epoch,pid:process.pid});
}else if(role==='worker'){
  await import('../../apps/server/dist/worker.js');
  process.send?.({type:'ready',role,pid:process.pid});
}else throw new Error('Unknown load child role');

function report(){
  const wall=performance.now(),cpu=process.cpuUsage();
  const message={type:'sample',role,pid:process.pid,at:Date.now(),intervalMs:wall-lastWall,memory:process.memoryUsage(),cpuCores:(cpu.user-lastCpu.user+cpu.system-lastCpu.system)/1000/(wall-lastWall),commandDurations:durations,waiting:runtime?.db.pool.waitingCount??null,sockets:runtime?.io.engine.clientsCount??null};
  durations=[];lastCpu=cpu;lastWall=wall;
  process.send?.(message);
}
const interval=setInterval(report,1000);interval.unref();
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;clearInterval(interval);report();
  if(runtime){await runtime.close();process.exit(0);}else process.emit('SIGTERM');
}
process.on('message',message=>{
  if(message==='measure'){durations=[];measuring=true;lastCpu=process.cpuUsage();lastWall=performance.now();}
  if(message==='stop')void stop();
});
process.on('disconnect',()=>{void stop();});
if(runtime)for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void stop();});
