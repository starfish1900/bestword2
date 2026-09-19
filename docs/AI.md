# Computer opponents, replay and help

## Playing

In Create game, choose Computer, Easy / Medium / Hard and 5 / 15 / 25 minutes. Sign-in is required. The human occupies the first seat and the computer the second; the first turn is still random. The normal three-second countdown, tile draws, 30-second increments, PASS, timeout rules and scoring apply. A computer game occupies the human's playing slot until that human passes or the game finishes. The computer is a system identity and cannot sign in.

Every AI game uses the ordinary PostgreSQL snapshot, accepted move history, command receipts, event log and notification outbox. It appears in live/recent games and remains replayable after restart. Any signed-in human account can replay it. Guests can watch live boards and clocks; complete replay/history is not delivered through guest HTTP, subscription, sync or terminal updates.

Recent games remain loaded across automatic refreshes. The client merges by game ID, retains the oldest loaded cursor, fetches through gaps when more than one page has arrived, and preserves scroll position and keyboard focus. The list is not limited to 50 total games; 50 is its page size.

## Vocabulary and exact search

`data/ai/EnEasy.txt` and `EnMedium.txt` preserve the supplied inputs. Normalized words are intersected with the full legal dictionary before building deterministic packed graphs. Easy retains **9,868** words (503,403-byte graph); Medium **38,359** (1,726,848 bytes). Their reports enumerate exclusions and record hashes. Easy is a subset of Medium, which is a subset of Hard. Human validation and opening-word selection always use the full dictionary.

All words formed by an Easy/Medium AI move, including perpendicular secondary words, must belong to that level's vocabulary. Fixed existing letters may come from larger human words. Search builds anchors and perpendicular cross-check masks, traverses the GADDAG in both board directions, consumes consonants from the private rack and vowels from the shared supply, and scores candidates through the production engine's scoring function. It keeps one best result and a bounded recursion stack rather than a list of every move. Canonical anchor selection prevents duplicate candidates. Equal scores break ties by word, horizontal before vertical, then row and column. An incomplete search cannot submit its best-so-far result or claim there are no legal moves.

See [search verification](progress/ai-search.md), [test evidence](evidence/ai-search-tests.json) and [stress benchmark](evidence/ai-search-benchmark.json). The benchmark compares generated moves with production validation; the tests independently compare the complete generated set with an exhaustive oracle.

## Strategic NO WORDS

The AI first finds the exact best immediate placement. If NO WORDS is legal and retaining tiles can increase its future rack, it considers up to four paired hypothetical continuations. Each pair uses the same sampled unseen consonants for both choices, a greedy full-dictionary opponent reply and the next best own move. The AI never receives the actual opponent rack or future draw order.

At least two complete pairs are required. NO WORDS wins only if its mean two-turn score advantage, net of the opponent reply, is at least the greater of 10 points or 10% of the immediate best score, and at least 75% of completed pairs favor waiting. Incomplete pairs are discarded. Optional lookahead has a maximum 1,500 ms budget and leaves a 500 ms clock guard. Otherwise the AI plays its exact immediate best move. The same policy applies at every level. With no legal placement, it chooses NO WORDS only when a consonant was actually drawn this turn and the opponent has not passed; otherwise it passes.

## Worker, durability and recovery

Run `npm run worker:ai` alongside `npm start` and `npm run worker`. The API admits new AI games only while a healthy compatible AI worker is available. `AI_MAX_GAMES` is a separate database-enforced cap within `MAX_ACTIVE_GAMES`. Admission and cancellation of any open human seek are atomic.

The dedicated AI process uses `AI_WORKERS` search threads, initially one. Each thread has a 128 MiB old-generation heap limit, 32 MiB young-generation limit and 4 MiB stack; packed graph buffers are additional fixed allocations. Limits bound an individual thread and do not constitute a whole-process RSS guarantee. API clocks and sockets remain outside CPU-intensive search.

Durable jobs are keyed by game and turn number. Workers claim with leases and `SKIP LOCKED`; lease tokens fence expired/duplicate results. Commits recheck the game, position, clock, vocabulary and policy under the game lock, validate all words using the normal engine, and save the move atomically. A game pins vocabulary hashes and policy version; incompatible worker versions cannot continue it silently. Ordinary presence changes do not invalidate an unchanged position.

AI health belongs to its own service epoch. Worker loss pauses affected games as an infrastructure interruption. A healthy compatible replica can take over; an API becoming healthy alone does not resume a game without a compatible AI worker. Repeated delivery cannot apply an accepted turn twice. Normal AI clock expiry is still a loss. A failed search thread withdraws worker readiness; the hosting process supervisor should restart the failed worker.

Inspect queue and completed-turn latency without reading private racks:

```sql
SELECT status, count(*) FROM ai_jobs GROUP BY status;
SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY updated_at-created_at) AS p95_ms
FROM ai_jobs WHERE status='completed';
SELECT kind,status,count(*) FROM service_epochs GROUP BY kind,status;
```

Jobs retain compact search and strategy summaries for diagnostics. They do not store hypothetical opponent racks or all candidate moves. See [operations](OPERATIONS.md) for deployment and scaling, and [AI load runner](../tools/ai-load/README.md) for local reproducible capacity checks.

The [completed one-hour mixed run](progress/ai-capacity.md) passed with ten AI games plus one human table: 22,820 AI turns, 557 ms p95 completion time and 313 MiB peak AI RSS, with no errors or duplicate moves. The AI process used one logical CPU. These measurements support the initial local admission choice but do not establish Render capacity.

## Tutorial integration

Every help/Rules entry opens one shared Rules / Video dialog. The local captioned MP4 is byte-for-byte identical to the supplied tutorial: SHA256 `9fbe34a89b81a63adf2653614849032775ee1c19a90a555736e5c9af326b78be`, 16,544,578 bytes, approximately 7:34. It is public, has native playback controls and chapter buttons, and is not downloaded until the viewer requests playback. Closing help or switching back to rules pauses it. Versioned asset URLs support byte ranges and immutable caching. The game stays mounted and connected while help is open; its clock continues.

The recording intentionally remains as delivered, including its original illustrations. Current written rules remain authoritative for the later vowel/consonant amendment. Video downloads count toward Render bandwidth; this integration adds no third-party hosting or paid service.
