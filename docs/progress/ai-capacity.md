# AI capacity verification — 19 September 2026

The final mixed one-hour run passed every acceptance gate with **10 simultaneous AI games plus one human-versus-human table**. It completed 22,820 AI turns and 1,055 completed-game cycles over 3600.06 measured seconds. Completed games were replaced through normal admission. All AI turns completed within five seconds; p95 was **557 ms**, p99 750 ms and the maximum 1294 ms. Strategic NO WORDS was selected 2,322 times.

There were zero errors, disconnections, retries, incomplete accepted searches or unexpected forfeits. The final database verification checked every saved game's invariants and exact correspondence between AI jobs, accepted turns and command receipts. Both application processes exited cleanly, and the runner removed only its owned fixtures. API command processing p95/p99 was 8.16/11.47 ms.

## Hardware and memory

The run used Node v24.14.0 on a Windows desktop with a 13th Gen Intel(R) Core(TM) i7-13700, 24 logical CPUs and 15.62 GiB RAM. The entire AI process was pinned to **one logical CPU**, with one production search thread. The API, test driver, PostgreSQL and Redis shared the same physical machine. The fixture humans used a minimum 1.5-second think time; the AI tables rotated Hard, Easy and Medium.

AI peak process RSS was **312.98 MiB**, well below the 70%-of-2-GiB gate. Final sampled RSS was 222.71 MiB. The recorded ten-minute windows are:

| Minutes | Mean AI RSS (MiB) | Peak sampled AI RSS (MiB) |
|---|---:|---:|
| 0–10 | 212.48 | 300.54 |
| 10–20 | 231.32 | 236.02 |
| 20–30 | 232.83 | 236.57 |
| 30–40 | 233.33 | 237.42 |
| 40–50 | 234.26 | 237.41 |
| 50–60 | 229.71 | 237.51 |

The raw report retains the full process-memory and queue time series. This bounded healthy workload produced no out-of-memory failure; it does not prove memory safety for every possible position, deployment size or workload.

## Provenance and limits

The runtime implementation was saved in local commit 2b1d002 before the run. All 29 recorded runtime, harness, lockfile and vocabulary hashes were unchanged when the run completed. Later release edits concern tests, documentation and evidence. The standalone archive checkpoint also installed and built successfully offline, reproducing all 25 compiled runtime/vocabulary artifacts.

The preceding 120-second probes at 1, 2, 5 and 10 AI games passed. They were followed by final recovery-compatibility and harness-verification fixes; the completed hour is the authoritative final capacity result. The interrupted earlier hour is not a completed test. Separate real integration tests cover worker loss, replacement, duplicate claims and recovery; the hour is a healthy-load test.

This measures the stated **local** workload. Pinning a desktop process to one logical CPU does not establish equivalent Render CPU speed or hosted capacity. The historical 5,000-human-game report is not a 5,000-AI-game result. Keep the initial AI cap at ten and measure the selected Render services before raising it. No public deployment or paid resources were created.

- [Completed hour report](../../tools/ai-load/reports/2026-09-19T14-51-25.445Z-10games/report.json)
- [Frozen artifact hashes](../../tools/ai-load/reports/2026-09-19T14-51-25.445Z-10games/artifact-hashes.json)
- [Release verification summary](../evidence/ai-release-verification.json)
- [Reproduction instructions](../../tools/ai-load/README.md)
