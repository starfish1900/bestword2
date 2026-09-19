import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { auditArtifact } from './audit.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (!process.env.LEXICON_BUILDER) throw new Error('Set LEXICON_BUILDER to the compiled Rust lexicon builder before regenerating AI artifacts.');
const folder = resolve(root, 'data/ai');
mkdirSync(folder, { recursive: true });
const dictionary = readFileSync(resolve(root, 'data/dictionary.txt'));
const full = new Set(dictionary.toString('utf8').trimEnd().split(/\r?\n/));
const manifest = { formatVersion: 1, fullDictionarySha256: hash(dictionary), fullWordCount: full.size, levels: {} };
for (const [level, sourceArg, expected] of [['easy', process.argv[2], 9868], ['medium', process.argv[3], 38359]]) {
  const originalPath = resolve(folder, level === 'easy' ? 'EnEasy.txt' : 'EnMedium.txt');
  const original = readFileSync(sourceArg ? resolve(sourceArg) : originalPath);
  if (sourceArg) writeFileSync(originalPath, original);
  const entries = original.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  // No case folding, stemming, added words, or replacement vocabulary.
  const words = [...new Set(entries)].filter(word => full.has(word)).sort();
  const rejected = [...new Set(entries)].filter(word => !full.has(word));
  assert.equal(words.length, expected, `Unexpected ${level} intersection; review source files before changing the manifest.`);
  const corpus = Buffer.from(words.join('\n') + '\n');
  const corpusPath = resolve(folder, `${level}.txt`);
  writeFileSync(corpusPath, corpus);
  manifest.levels[level] = { sourceFile: `data/ai/${level === 'easy' ? 'EnEasy.txt' : 'EnMedium.txt'}`, sourceSha256: hash(original), sourceEntries: entries.length, uniqueSourceEntries: new Set(entries).size, words: words.length, rejected, corpusSha256: hash(corpus), artifact: `data/${level}.gaddag` };
  if (process.env.LEXICON_BUILDER) {
    const output = resolve(root, `data/${level}.gaddag`);
    const report = resolve(folder, `${level}-build.json`);
    const build = spawnSync(process.env.LEXICON_BUILDER, [corpusPath, output, report], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(build.stderr || build.error?.message || 'GADDAG build failed');
    const bytes = readFileSync(output);
    const audit = auditArtifact(bytes, corpus);
    const second = spawnSync(process.env.LEXICON_BUILDER, [corpusPath, output, report], { encoding: 'utf8' });
    if (second.status !== 0) throw new Error(second.stderr || 'Reproducibility build failed');
    assert.deepEqual(readFileSync(output), bytes, 'Build must be byte-identical');
    Object.assign(manifest.levels[level], { artifactSha256: hash(bytes), artifactBytes: bytes.length, exactLanguage: audit.acceptedLanguageExact, minimal: audit.independentMinimality, reproducible: true });
  }
}
const easyWords = readFileSync(resolve(folder, 'easy.txt'), 'utf8').trimEnd().split('\n');
const mediumWords = new Set(readFileSync(resolve(folder, 'medium.txt'), 'utf8').trimEnd().split('\n'));
manifest.easySubsetOfMedium = easyWords.every(word => mediumWords.has(word));
assert(manifest.easySubsetOfMedium, 'Expected nested vocabulary levels');
writeFileSync(resolve(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
