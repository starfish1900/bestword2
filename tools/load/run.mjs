// npm run test:load -- --scenario smoke
// A subprocess supplies TS loading for the shared test-only legal-move finder.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./runner.ts',import.meta.url)),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true,env:process.env});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
