# BestWord

A live, two-player crossword game for the browser. Build connected words, find valuable bridges, and make every letter count.

BestWord includes accounts, an open game lobby, live spectating, permanent PASS, server-controlled clocks, completed games and move-by-move replay. It uses the supplied English dictionary of **279,320 words**. Racks remain private; vowel counts, total remaining consonants and rack sizes are public.

The source rules are in [docs/original-spec.txt](docs/original-spec.txt), with the agreed clarifications in [docs/DECISIONS.md](docs/DECISIONS.md). The delivery does not provision paid services or publish a live website automatically.

## Start the complete game locally

With Docker Desktop / Docker Engine and Compose installed, run from this folder:

```sh
docker compose up --build -d
```

Open **http://localhost:3000**. Create an account in each of two separate browser profiles or one normal window and one private window. Create a game in one, then join it in the other. A third browser window can watch without signing in.

Compose starts PostgreSQL, Valkey, the application and its background worker. It stores database data in persistent Docker volumes. To stop the local stack while preserving games and accounts:

```sh
docker compose down
```

The fixed credentials in Compose are only for this local demonstration. Configure private managed storage and HTTPS for deployment.

## Develop with Node.js

Use **Node.js 24 LTS** and npm. Rust is needed only to rebuild the lexicon; a verified prebuilt lexicon is included for normal application startup.

1. Install dependencies with `npm ci`.
2. Start PostgreSQL and Valkey with `docker compose up -d postgres valkey`.
3. Copy `.env.example` to `.env`. On Windows PowerShell: `Copy-Item .env.example .env`; on macOS/Linux: `cp .env.example .env`.
4. Run `npm run build` once, then `npm run dev`.
5. In another terminal in this folder, run `npm run worker`.
6. Open **http://localhost:5173**.

The API listens on port 3000 and Vite on port 5173. The browser uses Vite's same-origin proxy. `APP_ORIGIN` must exactly match the URL opened in the browser; `localhost` and `127.0.0.1` are different origins.

Without Docker, use your own PostgreSQL and Redis-compatible services, or see [the portable local services guide](tools/dev/README.md). The portable helper requires an available Redis-compatible binary; it does not bundle one with the game. Avoid starting Docker services on ports already occupied by the portable services.

To serve the compiled browser application directly, set `APP_ORIGIN=http://localhost:3000`, run `npm run build`, then run `npm start` and `npm run worker` in separate terminals. PostgreSQL and the key-value service must already be running.

## Play

- Choose **5, 15 or 25 minutes**, with **30 seconds added after each completed turn**.
- The game begins after both players connect and a shared three-second countdown.
- Each turn automatically draws up to two consonants, with a maximum of ten on the rack. Take vowels directly from the shared bag; **Y is a vowel**.
- Place at least two new tiles in one line. Every resulting word must be in the dictionary and contain 3–15 letters. Your principal word cannot repeat an earlier principal word or either opening word.
- **No words** skips one turn, but only if a consonant was drawn this turn and the opponent has not passed.
- **Pass forever** ends all your future turns and fixes your score. The opponent continues until passing or losing. A passed player may leave or start another game.
- Losing on time or after the 25-second detected-disconnection allowance overrides the score. Confirmed infrastructure interruptions pause affected games and allow reconnection before resuming.

For scoring, a word's **spans** are the newly filled squares strictly between its first and last preexisting tiles. A word with at least one span forms a bridge. Prefixes and suffixes outside those old tiles are not spans.

| Word | Score |
|---|---|
| Principal | Total letter value × (number of consonants + spans) |
| Secondary with a bridge | Total letter value × 2 |
| Secondary without a bridge | Total letter value |

### Enter a move

Click an empty square. The first click selects horizontal **⇨**; each subsequent empty-square click clears the draft and alternates horizontal/vertical **⇩**. Type letters or tap rack/vowel tiles. Existing tiles are skipped. **Backspace** erases the last typed tile; **Enter** submits; **Escape** clears the draft. The complete word is inferred, including any existing prefix and suffix. The arrow keys move keyboard focus around the board; Space selects the focused square.

Rejected moves preserve their draft. If a connection drops before an acknowledgement arrives, the client retries the same command identifier, so an accepted move cannot be counted twice.

Use the history icon for the complete scoring breakdown. Completed games support opening-position, previous/next, automatic and final-position replay. Replay shows the board and scores at the selected move; private racks are never revealed.

### Accounts

Usernames contain 3–15 ASCII letters or numbers and are unique regardless of case. Passwords contain 12–128 characters. Save your password securely: **there is no password recovery or email flow**. Change a known password from your account menu. Spectators do not need an account.

## Tests and verification

From the repository root:

```sh
npm run typecheck
npm test
npm run build
```

Integration tests use real PostgreSQL and Redis-compatible services. The server integration suite runs when `BESTWORD_INTEGRATION=1`; point it at a dedicated local test database, not production.

The latest recorded consolidated run passed [175 of 175 tests](docs/evidence/verification-175.json), including the real dependency and multi-instance cases. The final release [Chromium/WebKit run](docs/evidence/browser-release.json) passed **11 checks in 88.83 seconds**, with one explicit WebKit skip for the Chromium-only acknowledgement fixture. Firefox remains unverified locally because its Windows runtime cannot launch; the configured Linux CI run has not been executed here.

For the full browser workflow:

```sh
npx playwright install chromium firefox webkit
npm run test:e2e
```

By default the browser tests use the compiled application at `http://127.0.0.1:3000`, starting `npm start` if necessary. Set `APP_ORIGIN` to that origin. For an already running development preview set `BESTWORD_BASE_URL=http://localhost:5173`. Set `BESTWORD_CROSS_BROWSER=1` to run Chromium, Firefox and WebKit; otherwise the suite runs Chromium. `PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome for the Chromium project.

The browser suite creates two isolated accounts for each run, then reuses that pair across browser engines. It plays genuine legal words found from the supplied dictionary and verifies matchmaking, invalid drafts, revision-aware synchronization, scoring updates, NO WORDS, PASS, private/public views, replay and full-game layouts at **1280×800, 390×844, 320×568 and 568×320**. A separate 320×568 touch workflow taps rack/vowels, erases, submits and verifies the actual server score without keyboard input. Set `BESTWORD_E2E_RUN_ID` to reuse the same test pair across manual reruns when testing repeatedly against the account registration rate limit. Additional checks verify production HTTP compression, lobby recovery from an explicitly labeled missed-notification fixture, retained command IDs when a real commit's acknowledgement is replaced by a recovery-error fixture, and preserved clocks/input/drafts when only the page's wall clock jumps forward one hour during a real game.

Generated reports and screenshots are in `apps/web/test-results/`. The separate `apps/web/scripts/verify-layout.mjs` performs clearly identified wire-fixture layout checks; those checks are not evidence of live server behavior.

The isolated [backup/restore drill](docs/progress/backup.md) uses real `pg_dump` and `pg_restore` with disposable fixture databases. Run `node tools/testing/backup-restore.mjs` after building; set `BESTWORD_PG_BIN` if the PostgreSQL client tools are not included in the local runtime.

See [client verification notes](docs/progress/client.md), [engine verification notes](docs/progress/engine.md) and [lexicon verification notes](docs/progress/lexicon.md) for recorded results and limitations. To rebuild or independently audit the dictionary representation, follow [the lexicon compiler guide](tools/lexicon-builder/README.md).

## Project map

See [the implementation architecture](docs/ARCHITECTURE.md) for transaction flow, private/public projections, notifications, recovery and multi-instance scaling boundaries.

| Location | Responsibility |
|---|---|
| `apps/web` | React 19 / TypeScript / Vite 8 browser client, local draft state, live updates and replay |
| `apps/server` | Node 24 / Fastify 5 API, Socket.IO 4, accounts, durable commands, presence, recovery and background work |
| `packages/contracts` | Public types and validated network inputs |
| `packages/engine` | Deterministic game rules, draws, scoring, clocks and state transitions |
| `packages/lexicon` | Compact GADDAG loader and traversal API |
| `tools/lexicon-builder` | Rust offline compiler using Daciuk's incremental minimization, plus independent audits |
| `data` | Original dictionary, prebuilt lexicon and build/audit metadata |
| `tools/e2e` | Real browser-to-server acceptance tests |
| `tools/testing/backup-restore.mjs` | Guarded local PostgreSQL fixture backup/restore and receipt verification |
| `render.yaml`, `Dockerfile`, `compose.yml` | Render deployment blueprint and repeatable container/local setup |

## Render and growth

The Render Blueprint defines the application, worker, PostgreSQL and Key Value services. PostgreSQL owns accepted game state; commands lock only their own game. Server instances share presence and broadcasts through Key Value, so players in one game can connect to different application instances.

Follow [the operations and Render deployment guide](docs/OPERATIONS.md) for provisioning, configuration, backups, recovery, metrics and safe updates. [Deployment verification notes](docs/progress/deployment.md) distinguish prepared configuration from checks actually run. The [load-test guide](tools/load/README.md) describes isolated test data, scenarios and measured reports; run load tests only against a dedicated test environment.

The [fifteen-minute local scale trial](tools/load/reports/2026-09-18T06-31-39-890Z-scale.json) passed with **5,000 games, 2,500 spectators and 12,500 maintained sockets**, accepting **226,400 commands** at 250 baseline commands/second plus fourteen 100-command bursts. It included eight-second revision sync and 1,964 completed-game cycles. All durability, privacy and viewer-delivery gates passed, with zero errors or disconnects. Two API instances and one worker shared an i7-13700 Windows machine with the driver and databases. This establishes that specific local workload and duration, not Render capacity or cost.

The [full strict hour on final code](tools/load/reports/2026-09-18T05-30-44-454Z-acceptance.json) also passed: **100 simultaneous games, 1,000 spectators and 1,200 maintained sockets**, 185,805 accepted commands, 536,126 revision syncs and 5,183 completed-game cycles. All receipts, saved-state invariants and final viewer updates verified, with zero errors and clean child shutdown. See [capacity evidence](docs/progress/capacity.md) for exact workloads, hardware, provenance and the distinction between pushed revisions and fresh initialization views in the scale trial.

The initial active-game limit is configurable with `MAX_ACTIVE_GAMES`; it defaults to **100**. `MAX_SPECTATORS_PER_GAME` defaults to **10**. Increasing these limits is an operational decision that must follow capacity testing. More application instances, database resources and bandwidth can be provisioned without rewriting game rules or the browser client.

**5,000 simultaneous games is a capacity target, not a promise that the initial US$100/month configuration supports that load.** Only a measured load-test report establishes capacity on a particular configuration. The game ships with no rating system, chat, tournament mode or playing AI.
