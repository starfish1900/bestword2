import { test, expect } from '@playwright/test';
import { get } from 'node:http';
import { get as secureGet } from 'node:https';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

function raw(url:string,encoding:string):Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:Buffer}> {
  return new Promise((resolve,reject)=>{
    const read=url.startsWith('https:')?secureGet:get;
    const request=read(url,{agent:false,headers:{accept:'text/html,application/javascript,text/css,*/*','accept-encoding':encoding}},response=>{
      const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode??0,headers:response.headers,body:Buffer.concat(chunks)}));
    }).on('error',reject);
    request.setTimeout(10000,()=>request.destroy(new Error('Asset response timed out')));
  });
}

test('production assets negotiate Brotli and gzip without changing content',async({baseURL})=>{
  // The Vite development server does not serve the precompressed production output.
  test.skip(new URL(baseURL!).port==='5173','Production-build HTTP check');
  const html=await raw(`${baseURL}/`,'identity');expect(html.status,html.body.toString().slice(0,300)).toBe(200);
  const paths=['/',...new Set([...html.body.toString().matchAll(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/g)].map(match=>match[1]!))];
  expect(paths.length).toBeGreaterThanOrEqual(3);
  for(const path of paths){
    const plain=await raw(`${baseURL}${path}`,'identity');expect(plain.status).toBe(200);
    expect(plain.headers['content-type']).toMatch(path.endsWith('.js')?/javascript/:path.endsWith('.css')?/text\/css/:/text\/html/);
    for(const encoding of ['br','gzip']){
      const compressed=await raw(`${baseURL}${path}`,encoding);expect(compressed.status).toBe(200);
      expect(compressed.headers['content-encoding']).toBe(encoding);expect(compressed.headers['content-type']).toBe(plain.headers['content-type']);
      expect(String(compressed.headers.vary).toLowerCase()).toContain('accept-encoding');
      const decoded=encoding==='br'?brotliDecompressSync(compressed.body):gunzipSync(compressed.body);
      expect(decoded.equals(plain.body)).toBe(true);expect(compressed.body.length).toBeLessThan(plain.body.length);
    }
  }
});
