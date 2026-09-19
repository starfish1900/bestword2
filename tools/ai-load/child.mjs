// Local-only process metrics around the unchanged production entry points.
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { buildApp } from '../../apps/server/dist/app.js';
import { readConfig } from '../../apps/server/dist/config.js';
const role=process.env.BESTWORD_LOAD_ROLE;
let runtime,durations=[],lastCpu=process.cpuUsage(),lastWall=performance.now(),stopping=false;
if(role==='api'){
  runtime=await buildApp(readConfig());
  const command=runtime.games.command.bind(runtime.games);
  runtime.games.command=async(...args)=>{const start=performance.now();try{return await command(...args);}finally{durations.push(performance.now()-start);}};
  const url=await runtime.app.listen({host:'127.0.0.1',port:0});
  process.send?.({type:'ready',url});
}else if(role==='ai'){
  if(process.platform==='win32'){
    // Pin this owned test process (including search threads) to one logical CPU.
    execFileSync('powershell.exe',['-NoProfile','-Command',`$aiTestProcess=Get-Process -Id ${process.pid}; $aiTestProcess.ProcessorAffinity=[IntPtr]1; if($aiTestProcess.ProcessorAffinity.ToInt64() -ne 1){throw 'AI affinity was not applied'}`],{windowsHide:true,stdio:'pipe'});
  }
  await import('../../apps/server/dist/ai-worker.js');
  process.send?.({type:'ready',singleCpuAffinity:process.platform==='win32'});
}else throw new Error('Unknown test child role');
function sample(){const wall=performance.now(),cpu=process.cpuUsage();process.send?.({type:'sample',role,at:Date.now(),rss:process.memoryUsage().rss,cpuCores:(cpu.user-lastCpu.user+cpu.system-lastCpu.system)/1000/(wall-lastWall),durations});durations=[];lastCpu=cpu;lastWall=wall;}
const timer=setInterval(sample,1000);timer.unref();
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);sample();if(runtime){await runtime.close();process.exit(0);}else {process.emit('SIGTERM');process.disconnect?.();}}
process.on('message',message=>{if(message==='stop')void stop();});
process.on('disconnect',()=>{void stop();});

