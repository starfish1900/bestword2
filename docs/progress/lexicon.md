# Lexicon progress

Owned areas: Rust offline compiler, TypeScript runtime reader, prebuilt lexicon artifacts, and this report.

- Read the repository decisions and original dictionary; vocabulary remains unchanged.
- Installed task-local Rust 1.98.1 under the task's work/tools directory using official rustup, without changing global PATH or global Rust configuration.
- Implemented dependency-free Rust sorted incremental Daciuk minimization and a deterministic packed format: 7-byte state records, 3-byte transitions, front-coded 5-bit seed words, and SHA-256 integrity fields.
- Compiler validation checks every source word, every canonical transform, and exact accepted-language enumeration.
- Implemented the Node Buffer reader with only built-in dependencies. `Gaddag.open(path)` accepts raw or gzip bytes; `load(bytes)` is synchronous; `has(word)` rejects non-uppercase/non-ASCII input; `seedWords` contains a frozen sorted seed corpus. `root`, `next`, `isTerminal`, `edges`, and `hasTransformed` support traversal. `sha256` is the original corpus hash; `binarySha256` identifies packed bytes.

## Completed checks

- Rust compiler unit tests: **4 passed**, including canonical transforms, terminal-prefix/suffix merging, malformed corpus inputs, and standard SHA-256 test vectors.
- TypeScript type build: passed with strict, exact optional properties, and unchecked-index protection.
- Production reader tests: **12 passed** in 5.33 seconds, including every source word, every canonical transform, compressed loading, defensive buffer copying, invalid inputs, corrupted checksums/layout/edges/seeds, and an independently constructed nonminimal graph fixture.
- Independent JavaScript audit decodes serialized bytes without importing the compiler or reader. It proves minimality by bottom-up right-language equivalence classes and proves exact accepted-language equality by inverting every accepted path and checking a complete per-word split bitmask.
- Two separate Rust compilations produced **byte-identical raw artifacts**. Two gzip compressions under the recorded Node version were identical.
- Both compiler and production reader verified **279,320 source words**, **2,544,319 canonical transforms**, and **130,220 seed words**. No dictionary entries were added, removed, or normalized.

## Artifact and benchmark results

- 603,604 states, 1,306,607 transitions; 8,585,805 raw bytes; 5,373,266 gzip bytes.
- Source SHA-256: `87222d75c77c52574868bf0cefd4faf5703d4df166336a4ec9a70cffe72100af`.
- Binary SHA-256: `7c236cf68580937a2b5e9bb0ebd779512f1d71936cd82ad7f7b86c2a33879db9`.
- Compressed SHA-256: `a2c6ef6c62da93495848e3335b814788842021514131025ea44cde34fbd207d0`.
- Local Rust compile + full verification: 1.674 seconds; production reader raw load 77.6 ms; median full-corpus lookup pass 47.17 ms, about 5.92 million positive word lookups/second. Full transformed-language production lookup pass: 882.6 ms.
- Hardware: Windows x64, Intel Core i7-13700, 24 logical CPUs, approximately 16 GB RAM; Node v24.14.0 and Rust 1.98.1. These are **single-process local lexicon measurements**, not evidence of Render capacity, game concurrency, or network latency.

`data/lexicon-manifest.json` contains machine-readable audit and benchmark results. `tools/lexicon-builder/README.md` specifies the format and reproducible commands. Production uses the checked-in compressed artifact; Rust is not required by the server image.

The initial test runner invocation hit Windows sandbox child-process restrictions; the authorized elevated test invocation passed. No public deployment or purchase was performed.
