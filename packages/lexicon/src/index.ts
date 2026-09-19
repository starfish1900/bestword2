import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const HEADER_BYTES = 128;
const LABEL_MASK = 0x07ff_ffff;
const TERMINAL = 0x8000_0000;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_U24 = 0x00ff_ffff;

export class LexiconFormatError extends Error {
  constructor(message: string) { super(message); this.name = 'LexiconFormatError'; }
}

export interface GaddagEdge { readonly label: string; readonly target: number }
export interface GaddagLoadOptions { /** Search workers do not need the opening-word index. */ decodeSeeds?: boolean }

function requireFormat(condition: boolean, message: string): asserts condition {
  if (!condition) throw new LexiconFormatError(message);
}

function popcount(value: number): number {
  value -= (value >>> 1) & 0x5555_5555;
  value = (value & 0x3333_3333) + ((value >>> 2) & 0x3333_3333);
  return (((value + (value >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
}

function labelCode(label: string): number {
  if (label === '+') return 0;
  if (label.length !== 1) return -1;
  const code = label.charCodeAt(0) - 64;
  return code >= 1 && code <= 26 ? code : -1;
}

/**
 * Immutable, prebuilt minimized GADDAG. No word corpus is rebuilt at startup.
 * Source words are checked via their reversed-only canonical transform.
 * Labels in traversal APIs are uppercase A-Z and '+' (the split separator).
 */
export class Gaddag {
  readonly root: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly wordCount: number;
  readonly transformCount: number;
  readonly seedWords: readonly string[];
  /** SHA-256 of the exact original dictionary bytes; identifies the vocabulary. */
  readonly sha256: string;
  /** SHA-256 of the uncompressed packed artifact. */
  readonly binarySha256: string;
  readonly binaryBytes: number;
  private readonly data: Buffer;
  private readonly nodeOffset: number;
  private readonly edgeOffset: number;

  private constructor(input: Uint8Array, options: GaddagLoadOptions = {}) {
    requireFormat(input.byteLength >= HEADER_BYTES && input.byteLength <= MAX_BINARY_BYTES, 'Invalid lexicon size');
    // Copy so a caller cannot invalidate a verified graph by mutating its input.
    const bytes = Buffer.from(input);
    requireFormat(bytes.subarray(0, 8).toString('ascii') === 'BWGAD001', 'Invalid GADDAG magic');
    requireFormat(bytes.readUInt16LE(8) === 1 && bytes.readUInt16LE(10) === HEADER_BYTES, 'Unsupported GADDAG version');
    requireFormat(bytes.readUInt32LE(12) === 0 && bytes[59] === 0, 'Unsupported GADDAG flags');
    requireFormat(bytes[56] === 15 && bytes[57] === 7 && bytes[58] === 3, 'Unsupported GADDAG layout');
    this.nodeCount = bytes.readUInt32LE(16);
    this.edgeCount = bytes.readUInt32LE(20);
    this.root = bytes.readUInt32LE(24);
    this.wordCount = bytes.readUInt32LE(28);
    this.transformCount = bytes.readUInt32LE(32);
    const seedCount = bytes.readUInt32LE(36);
    this.nodeOffset = bytes.readUInt32LE(40);
    this.edgeOffset = bytes.readUInt32LE(44);
    const seedOffset = bytes.readUInt32LE(48);
    const seedBytes = bytes.readUInt32LE(52);
    requireFormat(this.nodeCount > 0 && this.nodeCount <= MAX_U24 && this.edgeCount <= MAX_U24, 'Invalid graph dimensions');
    requireFormat(this.root === this.nodeCount - 1 && this.wordCount > 0 && seedCount <= this.wordCount, 'Invalid graph root or word counts');
    requireFormat(this.nodeOffset === HEADER_BYTES && this.edgeOffset === HEADER_BYTES + this.nodeCount * 7, 'Invalid node section');
    requireFormat(seedOffset === this.edgeOffset + this.edgeCount * 3 && seedOffset + seedBytes === bytes.length, 'Invalid edge or seed section');
    requireFormat(bytes.readUInt32LE(60) === bytes.length - HEADER_BYTES, 'Invalid payload length');
    const payloadHash = createHash('sha256').update(bytes.subarray(HEADER_BYTES)).digest();
    requireFormat(timingSafeEqual(payloadHash, bytes.subarray(96, 128)), 'Lexicon payload checksum mismatch');
    this.sha256 = bytes.subarray(64, 96).toString('hex');
    this.binarySha256 = createHash('sha256').update(bytes).digest('hex');
    this.binaryBytes = bytes.length;
    this.data = bytes;
    this.validateGraph();
    this.seedWords = Object.freeze(this.decodeSeeds(seedOffset, seedCount, options.decodeSeeds !== false));
  }

  /** Read a .bin or gzip-compressed artifact once during process startup. */
  static async open(path: string | URL, options: GaddagLoadOptions = {}): Promise<Gaddag> {
    const bytes = await readFile(path);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try { return Gaddag.load(gunzipSync(bytes, { maxOutputLength: MAX_BINARY_BYTES }), options); }
      catch (error) {
        if (error instanceof LexiconFormatError) throw error;
        throw new LexiconFormatError(`Invalid compressed lexicon: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return Gaddag.load(bytes, options);
  }

  /** Load and validate an uncompressed packed artifact. */
  static load(bytes: Uint8Array, options: GaddagLoadOptions = {}): Gaddag { return new Gaddag(bytes, options); }

  /** Allocation-free bitmap: bit 0 is '+', bits 1..26 are A..Z. */
  transitionMask(state: number): number {
    this.checkState(state);
    return this.data.readUInt32LE(this.nodeOffset + state * 7) & LABEL_MASK;
  }

  /** Exact uppercase dictionary lookup; lowercase/non-ASCII input is rejected. */
  has(word: string): boolean {
    if (word.length < 3 || word.length > 15) return false;
    let state = this.root;
    for (let i = word.length - 1; i >= 0; i--) {
      const label = word.charCodeAt(i) - 64;
      if (label < 1 || label > 26) return false;
      const target = this.nextCode(state, label);
      if (target === null) return false;
      state = target;
    }
    return this.terminalUnchecked(state);
  }

  /** Traverse one labeled edge. Invalid state handles throw; absent labels return null. */
  next(state: number, label: string): number | null {
    this.checkState(state);
    const code = labelCode(label);
    return code < 0 ? null : this.nextCode(state, code);
  }

  isTerminal(state: number): boolean { this.checkState(state); return this.terminalUnchecked(state); }

  /** Ordered edges, with '+' before A-Z. Returned values do not expose the binary buffer. */
  edges(state: number): readonly GaddagEdge[] {
    this.checkState(state);
    const offset = this.nodeOffset + state * 7;
    const mask = this.data.readUInt32LE(offset) & LABEL_MASK;
    let edge = this.data.readUIntLE(offset + 4, 3);
    const result: GaddagEdge[] = [];
    for (let label = 0; label <= 26; label++) {
      if ((mask & (1 << label)) === 0) continue;
      result.push(Object.freeze({ label: label === 0 ? '+' : String.fromCharCode(64 + label), target: this.data.readUIntLE(this.edgeOffset + edge * 3, 3) }));
      edge++;
    }
    return Object.freeze(result);
  }

  /** Useful for audits and future anchor-based move generation. */
  hasTransformed(transformed: string): boolean {
    if (transformed.length < 3 || transformed.length > 16) return false;
    let state = this.root;
    for (const character of transformed) {
      const code = labelCode(character);
      if (code < 0) return false;
      const target = this.nextCode(state, code);
      if (target === null) return false;
      state = target;
    }
    return this.terminalUnchecked(state);
  }

  private checkState(state: number): void {
    if (!Number.isInteger(state) || state < 0 || state >= this.nodeCount) throw new RangeError('Invalid GADDAG state');
  }

  private terminalUnchecked(state: number): boolean {
    return (this.data.readUInt32LE(this.nodeOffset + state * 7) & TERMINAL) !== 0;
  }

  private nextCode(state: number, label: number): number | null {
    const offset = this.nodeOffset + state * 7;
    const mask = this.data.readUInt32LE(offset) & LABEL_MASK;
    const bit = 1 << label;
    if ((mask & bit) === 0) return null;
    const edge = this.data.readUIntLE(offset + 4, 3) + popcount(mask & (bit - 1));
    return this.data.readUIntLE(this.edgeOffset + edge * 3, 3);
  }

  private validateGraph(): void {
    const languageCounts = new Float64Array(this.nodeCount);
    const wordCounts = new Float64Array(this.nodeCount);
    const referenced = new Uint8Array(this.nodeCount);
    const longest = new Uint8Array(this.nodeCount);
    let expectedEdge = 0;
    for (let state = 0; state < this.nodeCount; state++) {
      const offset = this.nodeOffset + state * 7;
      const flags = this.data.readUInt32LE(offset);
      requireFormat((flags & 0x7800_0000) === 0, 'Reserved state flags are set');
      const mask = flags & LABEL_MASK;
      const degree = popcount(mask);
      const edgeStart = this.data.readUIntLE(offset + 4, 3);
      requireFormat(edgeStart === expectedEdge && edgeStart + degree <= this.edgeCount, 'Invalid edge range');
      expectedEdge += degree;
      let languageCount = (flags & TERMINAL) === 0 ? 0 : 1;
      let wordCount = languageCount;
      let maxLength = 0;
      let edge = edgeStart;
      for (let label = 0; label <= 26; label++) {
        if ((mask & (1 << label)) === 0) continue;
        const target = this.data.readUIntLE(this.edgeOffset + edge * 3, 3);
        requireFormat(target < state, 'Cyclic or non-bottom-up GADDAG edge');
        referenced[target] = 1;
        languageCount += languageCounts[target]!;
        if (label !== 0) wordCount += wordCounts[target]!;
        maxLength = Math.max(maxLength, longest[target]! + 1);
        edge++;
      }
      requireFormat(languageCount > 0 && Number.isSafeInteger(languageCount) && maxLength <= 16, 'Invalid accepted language');
      languageCounts[state] = languageCount;
      wordCounts[state] = wordCount;
      longest[state] = maxLength;
    }
    requireFormat(expectedEdge === this.edgeCount, 'Unclaimed graph edges');
    for (let state = 0; state < this.root; state++) requireFormat(referenced[state] === 1, 'Unreachable graph state');
    requireFormat(languageCounts[this.root] === this.transformCount && wordCounts[this.root] === this.wordCount, 'Accepted-language count mismatch');
    requireFormat(!this.terminalUnchecked(this.root), 'Empty word in dictionary');
  }

  private decodeSeeds(offset: number, count: number, retain: boolean): string[] {
    const words: string[] = [];
    let cursor = offset;
    let previous = '';
    for (let i = 0; i < count; i++) {
      requireFormat(cursor < this.data.length, 'Truncated seed index');
      const header = this.data[cursor++]!;
      const prefix = header >>> 4;
      const suffix = header & 15;
      const encodedBytes = Math.ceil(suffix * 5 / 8);
      requireFormat(prefix <= previous.length && suffix > 0 && cursor + encodedBytes <= this.data.length, 'Invalid seed prefix/suffix');
      let word = previous.slice(0, prefix);
      for (let letter = 0; letter < suffix; letter++) {
        const bit = letter * 5;
        const byte = cursor + (bit >>> 3);
        const pair = this.data[byte]! | ((byte + 1 < cursor + encodedBytes ? this.data[byte + 1]! : 0) << 8);
        const code = (pair >>> (bit & 7)) & 31;
        requireFormat(code < 26, 'Invalid seed letter');
        word += String.fromCharCode(65 + code);
      }
      const usedBits = (suffix * 5) & 7;
      requireFormat(usedBits === 0 || (this.data[cursor + encodedBytes - 1]! >>> usedBits) === 0, 'Nonzero seed padding');
      cursor += encodedBytes;
      requireFormat(word.length >= 9 && word.length <= 12 && word > previous && this.has(word), 'Invalid or unordered seed word');
      if (retain) words.push(word);
      previous = word;
    }
    requireFormat(cursor === this.data.length, 'Trailing seed data');
    return words;
  }
}
