import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gaddag } from '../../lexicon/dist/index.js';
import { createGame, setConnected, startIfReady, projectGame, applyAction, evaluatePlacement } from '../../engine/dist/index.js';
import { findBestMove, decideMove } from '../dist/index.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const full = await Gaddag.open(resolve(root, 'data/lexicon.bin'));
const graphs = { easy: await Gaddag.open(resolve(root, 'data/easy.gaddag'), { decodeSeeds: false }), medium: await Gaddag.open(resolve(root, 'data/medium.gaddag'), { decodeSeeds: false }), hard: full };
function opening(seed) {
  let random = seed;
  let state = createGame({ id: `benchmark-${seed}`, players: [{ id: 'one', username: 'One' }, { id: 'two', username: 'Two' }], minutes: 25, lexiconVersion: full.sha256, seedWords: full.seedWords, now: 0, randomInt: max => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % max; }, firstSeat: 0 }, full);
  state = setConnected(state, 0, true, 0); state = setConnected(state, 1, true, 0); return startIfReady(state, 3000);
}
function position(state) {
  const view = projectGame(state, state.activeSeat, state.lastTransitionAt);
  return { gameId: state.id, revision: state.revision, board: view.game.board, rack: view.you.rack, vowels: view.game.vowelsRemaining, principalHistory: view.game.principalHistory, opponentRackSize: view.game.players[1 - state.activeSeat].rackSize, opponentPassed: view.game.players[1 - state.activeSeat].passed, drawnThisTurn: view.you.drawnThisTurn, consonantsRemaining: view.game.consonantsRemaining };
}
const cases = [];
for (let seed = 1; seed <= 10; seed++) {
  let state = opening(seed); cases.push({ name: `opening-${seed}`, state });
  for (let turn = 0; turn < 8; turn++) state = applyAction(state, state.activeSeat, { type: 'NO_WORDS' }, state.lastTransitionAt + 1, full);
  cases.push({ name: `full-rack-${seed}`, state });
  for (let turn = 0; turn < 24 && state.status === 'active'; turn++) {
    const current = position(state), best = findBestMove(current, full);
    const action = best.move ?? { type: current.drawnThisTurn > 0 && !current.opponentPassed ? 'NO_WORDS' : 'PASS' };
    state = applyAction(state, state.activeSeat, action, state.lastTransitionAt + 1, full);
    if (turn === 9 || turn === 19) cases.push({ name: `played-${turn + 1}-${seed}`, state });
  }
}
const runs = [];
for (const { name, state } of cases) for (const [level, graph] of Object.entries(graphs)) {
  if (state.status !== 'active') continue;
  let verified = 0;
  const search = findBestMove(position(state), graph, { onMove: (move, score) => {
    const evaluation = evaluatePlacement(state, state.activeSeat, move, full);
    if (evaluation.score !== score || evaluation.words.some(word => !graph.has(word.word))) throw new Error(`Invalid ${level} candidate ${move.word}`);
    verified++;
  } });
  const started = performance.now();
  const decision = decideMove(position(state), { play: graph, full }, { remainingClockMs: 300_000 });
  runs.push({ name, level, rackSize: state.players[state.activeSeat].rack.length, occupied: state.board.filter(Boolean).length, exact: search.complete, candidates: verified, searchVisited: search.stats.visited, auditedSearchMs: search.stats.elapsedMs, decisionMs: performance.now() - started, decisionVisited: decision.stats.visited, completedPairs: decision.strategy.completedPairs, rss: process.memoryUsage().rss });
}
global.gc?.();
const baseline = process.memoryUsage();
const memory = [];
const soakStart = performance.now();
for (let repeat = 0; repeat < 250; repeat++) {
  const state = cases[repeat % cases.length].state;
  if (state.status === 'active') findBestMove(position(state), full);
  if (repeat % 25 === 24) { global.gc?.(); memory.push({ searches: repeat + 1, ...process.memoryUsage() }); }
}
const report = { createdAt: new Date().toISOString(), environment: { node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, hostBytes: totalmem() }, limitations: 'Single-process local CPU and memory exercise; not a Render or concurrent-service capacity result. Audited search timings include production validation of every candidate.', runs, soak: { searches: 250, elapsedMs: performance.now() - soakStart, baseline, samples: memory }, totalCandidatesValidated: runs.reduce((sum, run) => sum + run.candidates, 0) };
const output = resolve(root, 'docs/evidence/ai-search-benchmark.json'); mkdirSync(resolve(root, 'docs/evidence'), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, cases: runs.length, totalCandidatesValidated: report.totalCandidatesValidated, maxDecisionMs: Math.max(...runs.map(run => run.decisionMs)), maxCandidates: Math.max(...runs.map(run => run.candidates)), rssBefore: baseline.rss, rssAfter: memory.at(-1)?.rss, peakRss: Math.max(...runs.map(run => run.rss), ...memory.map(sample => sample.rss)), soakMs: report.soak.elapsedMs }, null, 2));
