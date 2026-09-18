# Offline BestWord lexicon

The Rust compiler has no third-party dependencies. The original dictionary is
immutable input. Production starts from the prebuilt `data/lexicon.bin.gz`; it
does not compile the dictionary or construct a per-game graph.

From the repository root, with Rust and Node 24 available:

```sh
cargo test --manifest-path tools/lexicon-builder/Cargo.toml
cargo run --release --manifest-path tools/lexicon-builder/Cargo.toml -- data/dictionary.txt data/lexicon.bin data/lexicon-build-report.json
cargo run --release --manifest-path tools/lexicon-builder/Cargo.toml -- data/dictionary.txt tools/lexicon-builder/target/repro.bin tools/lexicon-builder/target/repro-report.json
npm run build -w @bestword/lexicon
node tools/lexicon-builder/finalize.mjs tools/lexicon-builder/target/repro.bin
```

`finalize.mjs` independently audits the serialized graph, checks every word and
transform through the production reader, compares two Rust builds byte for byte,
compresses deterministically, and writes `data/lexicon-manifest.json`. Its
benchmarks describe the machine on which it actually ran, not Render capacity.

## Construction

For each word and each split `1..length`, generate reversed prefix, `+`, and the
remaining suffix; the final split emits only the reversed full word. For CARE:
`C+ARE`, `AC+RE`, `RAC+E`, `ERAC`. Sorting uses `+` before `A..Z`.

The compiler implements Daciuk's sorted incremental algorithm: retain only the
current word's unchecked suffix, minimize completed suffix states bottom-up at
the next divergence, and register states by terminal flag and labeled canonical
successors. Nodes receive deterministic bottom-up IDs independent of hash-table
iteration order. It emits a minimal deterministic acyclic automaton.

## Binary version 1

All integers are unsigned little endian. Labels use `+=0`, `A=1`, ..., `Z=26`.

| Header offset | Bytes | Field |
|---|---:|---|
| 0 | 8 | ASCII `BWGAD001` |
| 8 | 2 | Version = 1 |
| 10 | 2 | Header length = 128 |
| 12 | 4 | Reserved flags = 0 |
| 16,20,24 | 4 each | Node count, edge count, root node |
| 28,32,36 | 4 each | Source word count, transform count, seed count |
| 40,44,48 | 4 each | Node, edge, seed section offsets |
| 52 | 4 | Seed section length |
| 56,57,58,59 | 1 each | Maximum word length 15, node width 7, edge width 3, reserved 0 |
| 60 | 4 | Payload length |
| 64 | 32 | SHA-256 of original dictionary bytes |
| 96 | 32 | SHA-256 of all bytes after the header |

Each **7-byte state** contains a 32-bit label bitmap (bits 0-26), a terminal bit
(bit 31), and its first edge index in 24 bits. Bits 27-30 are reserved. Each
**3-byte edge** contains a target state ID. Edges appear in ascending label order;
popcount of lower label bits determines a transition's array index. Every target
ID is smaller than its source ID, making acyclicity directly verifiable. The root
is the final state. No unused states or edges are permitted.

The seed index contains all source words of length 9-12 in sorted order. Each
record starts with a byte containing the common-prefix length in its high nibble
and suffix length in its low nibble. Suffix letters use 5 bits each (`A=0`), packed
least-significant bit first, then zero-padded to the next byte. This avoids a
second textual seed dictionary and preserves exact uniform word sampling.

Gzip is only a distribution wrapper. `Gaddag.open` recognizes its magic bytes,
inflates once with a fixed maximum output size, and validates the raw artifact.
`Gaddag.load` takes raw bytes and retains a defensive copy. The reader checks
layout, checksums, edge ranges, acyclicity, reachability, accepted-word/transform
counts, and the seed index. Independent offline audits additionally prove exact
language equality and absence of equivalent states.

## Runtime interface

```ts
import { Gaddag } from '@bestword/lexicon';
const lexicon = await Gaddag.open('data/lexicon.bin.gz');
lexicon.has('ROOMMATE');       // exact uppercase dictionary lookup
lexicon.seedWords;            // frozen sorted array, lengths 9-12
lexicon.sha256;               // original dictionary SHA-256 / vocabulary version
lexicon.binarySha256;         // packed artifact SHA-256
lexicon.next(lexicon.root,'R');
lexicon.isTerminal(state);
lexicon.edges(state);         // '+' then A..Z, immutable records
```

Invalid state handles throw `RangeError`; absent or invalid edge labels return
`null`. Invalid word strings return `false`. Corrupt artifacts throw
`LexiconFormatError`. The runtime imports only Node built-ins.
