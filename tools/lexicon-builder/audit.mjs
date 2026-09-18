// Independent verifier. It deliberately does not import the TypeScript reader
// or the Rust construction code; it checks the serialized graph directly.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const symbol = (code) => code === 0 ? '+' : String.fromCharCode(64 + code);

export function auditArtifact(bytes, dictionaryBytes) {
  const started = performance.now();
  assert.equal(bytes.toString('ascii', 0, 8), 'BWGAD001');
  assert.equal(bytes.readUInt16LE(8), 1);
  assert.equal(bytes.readUInt16LE(10), 128);
  assert.equal(bytes.subarray(64, 96).toString('hex'), hash(dictionaryBytes));
  assert.equal(bytes.subarray(96, 128).toString('hex'), hash(bytes.subarray(128)));
  const words = dictionaryBytes.toString('utf8').trimEnd().split(/\r?\n/);
  assert(words.every((word, i) => /^[A-Z]{3,15}$/.test(word) && (i === 0 || words[i-1] < word)));
  const wordIds = new Map(words.map((word, i) => [word, i]));
  const wordMasks = new Uint16Array(words.length);
  const count = bytes.readUInt32LE(16);
  const edgeCount = bytes.readUInt32LE(20);
  const root = bytes.readUInt32LE(24);
  const nodeOffset = bytes.readUInt32LE(40);
  const edgeOffset = bytes.readUInt32LE(44);
  const seedOffset = bytes.readUInt32LE(48);
  assert.equal(bytes.readUInt32LE(28), words.length);
  assert.equal(root, count-1);
  assert.equal(nodeOffset, 128);
  assert.equal(edgeOffset, nodeOffset + count*7);
  assert.equal(seedOffset, edgeOffset + edgeCount*3);
  assert.equal(bytes.length, seedOffset + bytes.readUInt32LE(52));
  const stateMask = (id) => bytes.readUInt32LE(nodeOffset + id*7);
  const firstEdge = (id) => bytes.readUIntLE(nodeOffset + id*7+4, 3);
  const targetAt = (edge) => bytes.readUIntLE(edgeOffset + edge*3, 3);

  // Compute right-language equivalence classes bottom-up from the serialized
  // graph. Distinct states with the same terminal/label/successor-class signature
  // are equivalent and violate minimality, even if they have different IDs.
  const classes = new Uint32Array(count);
  const signatures = new Map();
  const referenced = new Uint8Array(count);
  let expectedEdge = 0;
  for (let id=0; id<count; id++) {
    const mask = stateMask(id);
    assert.equal(mask & 0x7800_0000, 0);
    let edge = firstEdge(id);
    assert.equal(edge, expectedEdge);
    let signature = (mask & 0x8000_0000) ? 'T' : 'N';
    for (let label=0;label<27;label++) {
      if (!(mask & (1<<label))) continue;
      const target = targetAt(edge++);
      assert(target < id, 'Serialized graph must be acyclic and bottom-up');
      referenced[target] = 1;
      signature += `|${label}:${classes[target]}`;
    }
    assert(!signatures.has(signature), `Equivalent states detected: ${signatures.get(signature)} and ${id}`);
    signatures.set(signature, id);
    classes[id] = id+1;
    expectedEdge = edge;
  }
  assert.equal(expectedEdge, edgeCount);
  for (let id=0;id<root;id++) assert.equal(referenced[id],1,`Unreachable state ${id}`);
  const minimalityMs = performance.now()-started;

  // Enumerate every accepted string and invert its canonical transform. One
  // bit per split per source word proves exact coverage without retaining the
  // builder's 2.5-million-string sorted transform list.
  let accepted = 0;
  let maxPathLength = 0;
  const path = [];
  function visit(id) {
    const mask = stateMask(id);
    if (mask & 0x8000_0000) {
      const text = path.map(symbol).join('');
      const split = text.indexOf('+');
      let word;
      let prefixLength;
      if (split < 0) {
        word = [...text].reverse().join('');
        prefixLength = text.length;
      } else {
        assert(split > 0 && split < text.length-1 && text.lastIndexOf('+') === split, 'Noncanonical accepted transform');
        word = [...text.slice(0,split)].reverse().join('') + text.slice(split+1);
        prefixLength = split;
      }
      const index = wordIds.get(word);
      assert(index !== undefined, `Extraneous accepted dictionary word ${word}`);
      const bit = 1 << (prefixLength-1);
      assert.equal(wordMasks[index] & bit, 0, `Duplicate transform of ${word}`);
      wordMasks[index] |= bit;
      maxPathLength = Math.max(maxPathLength,path.length);
      accepted++;
    }
    let edge = firstEdge(id);
    for (let label=0;label<27;label++) {
      if (!(mask & (1<<label))) continue;
      assert(path.length<16, 'Oversized transform');
      path.push(label);visit(targetAt(edge++));path.pop();
    }
  }
  visit(root);
  const expectedTransforms = words.reduce((sum, word)=>sum+word.length,0);
  assert.equal(accepted, expectedTransforms);
  assert.equal(accepted, bytes.readUInt32LE(32));
  words.forEach((word,index)=>assert.equal(wordMasks[index], (1<<word.length)-1,`Missing transform of ${word}`));

  const seeds = [];
  let previous = '';
  let cursor = seedOffset;
  while (cursor<bytes.length) {
    const header = bytes[cursor++];
    const prefix = header>>>4;
    const suffix = header&15;
    assert(prefix<=previous.length && suffix>0);
    const dataBytes = Math.ceil(suffix*5/8);
    assert(cursor+dataBytes<=bytes.length);
    let word = previous.slice(0,prefix);
    for (let i=0;i<suffix;i++) {
      const bit=i*5;
      let value=0;
      // Independent bit-by-bit decoding, rather than the runtime's two-byte
      // shift, also verifies the compact seed encoding against the corpus.
      for (let b=0;b<5;b++) value |= ((bytes[cursor+((bit+b)>>>3)] >>> ((bit+b)&7))&1)<<b;
      assert(value<26);word+=String.fromCharCode(65+value);
    }
    cursor+=dataBytes;seeds.push(word);previous=word;
  }
  assert.deepEqual(seeds,words.filter(word=>word.length>=9 && word.length<=12));
  assert.equal(seeds.length,bytes.readUInt32LE(36));
  return {
    independentAudit:true, independentMinimality:true, acceptedLanguageExact:true,
    words:words.length, transforms:accepted, seedWords:seeds.length,
    nodes:count, edges:edgeCount, maxPathLength,
    minimalityMs, totalAuditMs:performance.now()-started,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dictionary='data/dictionary.txt', binary='data/lexicon.bin'] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(auditArtifact(readFileSync(binary),readFileSync(dictionary)),null,2)+'\n');
}
