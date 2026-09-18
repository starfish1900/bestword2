import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config=readConfig();
const runtime=await buildApp(config);
await runtime.app.listen({port:config.PORT,host:config.HOST});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void runtime.close().then(()=>process.exit(0)).catch(error=>{runtime.app.log.error(error);process.exit(1);});});
