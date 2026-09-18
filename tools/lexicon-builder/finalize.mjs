import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cpus, totalmem, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Gaddag } from '../../packages/lexicon/dist/index.js';
import { auditArtifact } from './audit.mjs';

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const dictionary = readFileSync('data/dictionary.txt');
const bytes = readFileSync('data/lexicon.bin');
const build = JSON.parse(readFileSync('data/lexicon-build-report.json','utf8'));
const compressed = gzipSync(bytes,{level:9});
assert.deepEqual(gunzipSync(compressed),bytes);
assert.deepEqual(gzipSync(bytes,{level:9}),compressed,'Compression must be reproducible');
writeFileSync('data/lexicon.bin.gz',compressed);
const audit = auditArtifact(bytes,dictionary);
const openedAt = performance.now();
const lexicon = Gaddag.load(bytes);
const loadMs = performance.now()-openedAt;
const words = dictionary.toString('utf8').trimEnd().split(/\r?\n/);
const rounds=[];
for(let round=0;round<5;round++) {
  const started=performance.now();
  for(const word of words) assert(lexicon.has(word),`Runtime rejected ${word}`);
  rounds.push(performance.now()-started);
}
const transformAt = performance.now();
let checked=0;
for(const word of words) {
  for(let split=1;split<=word.length;split++) {
    const transformed=[...word.slice(0,split)].reverse().join('')+(split<word.length?'+'+word.slice(split):'');
    assert(lexicon.hasTransformed(transformed),`Runtime rejected ${transformed}`);checked++;
  }
}
assert.equal(checked,build.transforms);
const runtimeTransformsMs=performance.now()-transformAt;
const reproduciblePath=process.argv[2];
if(!reproduciblePath) throw new Error('Pass the independently rebuilt binary path to certify reproducibility');
assert.deepEqual(readFileSync(reproduciblePath),bytes,'Independent Rust builds must be byte-identical');
const medianMs=[...rounds].sort((a,b)=>a-b)[2];
const report={
  ...build,
  compressedBytes:compressed.length, compressedSha256:hash(compressed),
  reproducibleBuildVerified:true, reproducibleCompressionVerified:true,
  runtimeAllWordsVerified:true,runtimeAllTransformsVerified:true,
  independent:audit,
  benchmark:{
    hardware:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},
    runtime:process.version,loadUncompressedMs:loadMs,corpusLookupRoundsMs:rounds,
    medianCorpusLookupMs:medianMs,medianWordsPerSecond:Math.round(words.length/(medianMs/1000)),runtimeTransformsMs,
    notes:'Single-process local lexicon microbenchmark. This does not measure game-server concurrency, Render capacity, network latency, or resident memory requirements.',
  },
};
writeFileSync('data/lexicon-manifest.json',JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify(report,null,2)+'\n');
