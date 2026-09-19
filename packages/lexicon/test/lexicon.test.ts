import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Gaddag, LexiconFormatError } from '../src/index.js';
// Independent audit intentionally reads the bytes without importing Gaddag.
import { auditArtifact } from '../../../tools/lexicon-builder/audit.mjs';

const artifactUrl = new URL('../../../data/lexicon.bin', import.meta.url);
const gzipUrl = new URL('../../../data/lexicon.bin.gz', import.meta.url);
const source = readFileSync(new URL('../../../data/dictionary.txt', import.meta.url));
const bytes = readFileSync(artifactUrl);
const words = source.toString('utf8').trimEnd().split(/\r?\n/);
const lexicon = Gaddag.load(bytes);

function mutate(change: (copy: Buffer) => void): Buffer {
  const copy = Buffer.from(bytes);
  change(copy);
  createHash('sha256').update(copy.subarray(128)).digest().copy(copy, 96);
  return copy;
}

describe('prebuilt minimized GADDAG', () => {
  it('preserves the exact source corpus and public metadata', () => {
    expect(lexicon.sha256).toBe('87222d75c77c52574868bf0cefd4faf5703d4df166336a4ec9a70cffe72100af');
    expect(lexicon.wordCount).toBe(279_320);
    expect(lexicon.transformCount).toBe(2_544_319);
    expect(lexicon.seedWords).toEqual(words.filter(word => word.length >= 9 && word.length <= 12));
    expect(lexicon.seedWords).toHaveLength(130_220);
    expect(Object.isFrozen(lexicon.seedWords)).toBe(true);
  });

  it('accepts every source word through the production lookup', () => {
    for (const word of words) if (!lexicon.has(word)) throw new Error(`Rejected ${word}`);
  });

  it('accepts all 2,544,319 canonical source transforms', () => {
    let tested = 0;
    for (const word of words) {
      for (let split = 1; split <= word.length; split++) {
        const transformed = [...word.slice(0, split)].reverse().join('') + (split < word.length ? '+' + word.slice(split) : '');
        if (!lexicon.hasTransformed(transformed)) throw new Error(`Rejected ${transformed}`);
        tested++;
      }
    }
    expect(tested).toBe(2_544_319);
  }, 30_000);

  it('independently proves exact accepted language and minimality from serialized bytes', () => {
    const audit = auditArtifact(bytes, source);
    expect(audit.independentMinimality).toBe(true);
    expect(audit.acceptedLanguageExact).toBe(true);
    expect(audit.transforms).toBe(2_544_319);
  }, 30_000);

  it('loads the gzip distribution to the same verified artifact', async () => {
    const compressed = await Gaddag.open(gzipUrl);
    expect(compressed.binarySha256).toBe(lexicon.binarySha256);
    expect(compressed.seedWords).toEqual(lexicon.seedWords);
  });

  it('traverses labels without confusing terminal state zero with a missing edge', () => {
    for (const transformed of ['ERAC', 'C+ARE', 'AC+RE', 'RAC+E']) {
      let state = lexicon.root;
      for (const label of transformed) {
        const target = lexicon.next(state, label);
        expect(target).not.toBeNull();
        state = target!;
      }
      expect(lexicon.isTerminal(state)).toBe(true);
    }
    expect(lexicon.isTerminal(0)).toBe(true);
    expect(lexicon.edges(0)).toEqual([]);
    expect(lexicon.next(0, 'A')).toBeNull();
    const rootEdges = lexicon.edges(lexicon.root);
    expect(rootEdges.map(edge => edge.label)).toEqual([...rootEdges.map(edge => edge.label)].sort());
    expect(Object.isFrozen(rootEdges)).toBe(true);
  });

  it('rejects invalid inputs and bad state handles', () => {
    for (const word of ['', 'AA', 'roommate', 'RÖÖM', 'ABC+', 'ABCDEFGHIJKLMNOP', 'ZZZZZZZZZZZZZZZ', 'ROOMMATE\n']) {
      expect(lexicon.has(word), word).toBe(false);
    }
    for (const word of ['CARE+', '+CARE', 'ERAC+', 'C++ARE', 'care']) expect(lexicon.hasTransformed(word)).toBe(false);
    for (const state of [-1, 0.5, Number.NaN, lexicon.nodeCount]) expect(() => lexicon.next(state, 'A')).toThrow(RangeError);
    expect(lexicon.next(lexicon.root, '?')).toBeNull();
    expect(lexicon.next(lexicon.root, 'AA')).toBeNull();
  });

  it('defensively copies the verified input buffer', () => {
    const mutable = Buffer.from(bytes);
    const copy = Gaddag.load(mutable);
    mutable.fill(0);
    expect(copy.has('ROOMMATE')).toBe(true);
    expect(copy.seedWords).toHaveLength(130_220);
  });

  it('loads for search without retaining seeds while preserving graph validation and traversal', () => {
    const search = Gaddag.load(bytes, { decodeSeeds: false });
    expect(search.seedWords).toEqual([]);
    expect(search.binarySha256).toBe(lexicon.binarySha256);
    expect(search.has('ROOMMATE')).toBe(true);
    for (let state = 0; state < 1000; state++) {
      const mask = lexicon.edges(state).reduce((value, edge) => value | (1 << (edge.label === '+' ? 0 : edge.label.charCodeAt(0) - 64)), 0);
      expect(search.transitionMask(state)).toBe(mask);
    }
    expect(() => Gaddag.load(mutate(b => { b[b.readUInt32LE(48)] = 0xff; }), { decodeSeeds: false })).toThrow();
    expect(() => search.transitionMask(-1)).toThrow(RangeError);
  });

  it('rejects truncation, extra bytes, wrong magic, and unsupported versions', () => {
    expect(() => Gaddag.load(bytes.subarray(0, 100))).toThrow(LexiconFormatError);
    expect(() => Gaddag.load(bytes.subarray(0, -1))).toThrow(LexiconFormatError);
    expect(() => Gaddag.load(Buffer.concat([bytes, Buffer.from([0])]))).toThrow(LexiconFormatError);
    expect(() => Gaddag.load(mutate(b => b.write('NOTGAD00', 0)))).toThrow(LexiconFormatError);
    expect(() => Gaddag.load(mutate(b => b.writeUInt16LE(2, 8)))).toThrow(LexiconFormatError);
  });

  it('rejects damaged payloads before using their transitions', () => {
    const damaged = Buffer.from(bytes);
    damaged[1000] = damaged[1000]! ^ 1;
    expect(() => Gaddag.load(damaged)).toThrow(/checksum/);
  });

  it('rejects structural corruption even after its payload checksum is recomputed', () => {
    expect(() => Gaddag.load(mutate(b => b.writeUInt32LE(999, 28)))).toThrow(/count/);
    expect(() => Gaddag.load(mutate(b => b.writeUIntLE(1, 128 + 4, 3)))).toThrow(/edge range/);
    expect(() => Gaddag.load(mutate(b => b.writeUInt32LE(0x8800_0000, 128)))).toThrow(/Reserved/);
    expect(() => Gaddag.load(mutate(b => b.writeUIntLE(lexicon.root, b.readUInt32LE(44), 3)))).toThrow(/Cyclic/);
    expect(() => Gaddag.load(mutate(b => { b[b.readUInt32LE(48)] = 0xff; }))).toThrow(/seed prefix/);
  });

  it('the independent minimality check detects equivalent serialized states', () => {
    // The first two terminal states are semantically identical. This fixture is
    // deliberately outside the compiler and does not rely on its intern table.
    const fixture = Buffer.alloc(128 + 7 * 4 + 3 * 2);
    fixture.write('BWGAD001', 0); fixture.writeUInt16LE(1, 8); fixture.writeUInt16LE(128, 10);
    fixture.writeUInt32LE(4, 16); fixture.writeUInt32LE(2, 20); fixture.writeUInt32LE(3, 24);
    fixture.writeUInt32LE(1, 28); fixture.writeUInt32LE(3, 32);
    fixture.writeUInt32LE(128, 40); fixture.writeUInt32LE(156, 44); fixture.writeUInt32LE(162, 48);
    fixture.writeUInt32LE(0x8000_0000, 128); fixture.writeUInt32LE(0x8000_0000, 135);
    fixture.writeUInt32LE(1 << 1, 142); fixture.writeUInt32LE(1 << 2, 149); fixture.writeUIntLE(1, 153, 3);
    fixture.writeUIntLE(0, 156, 3); fixture.writeUIntLE(1, 159, 3);
    const dictionary = Buffer.from('AAA\n');
    createHash('sha256').update(dictionary).digest().copy(fixture, 64);
    createHash('sha256').update(fixture.subarray(128)).digest().copy(fixture, 96);
    expect(() => auditArtifact(fixture, dictionary)).toThrow(/Equivalent states/);
  });
});
