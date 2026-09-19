import { createHash } from 'node:crypto';
import { LETTERS, isVowel, type GameAction, type Letter } from '@bestword/contracts';
import { INITIAL_COUNTS } from '@bestword/engine';
import { applyPlacement, findBestMove, type AiPosition, type SearchLexicon, type SearchStats } from './search.js';

export const AI_POLICY_VERSION = 'bestword-ai-1';

export interface AiDecisionPosition extends AiPosition {
  gameId: string;
  revision: number;
  opponentRackSize: number;
  consonantsRemaining: number;
  drawnThisTurn: number;
  opponentPassed: boolean;
}
export interface DecisionOptions {
  remainingClockMs: number;
  shouldCancel?: () => boolean;
  now?: () => number;
  /** May reduce optional work; the shipped maximum remains 1,500 ms. */
  rolloutBudgetMs?: number;
}
export interface StrategyReport {
  reason: 'best-placement' | 'strategic-no-words' | 'no-legal-move' | 'cancelled';
  completedPairs: number;
  improvements: number[];
  meanImprovement: number;
  requiredImprovement: number;
}
export interface DecisionResult {
  complete: boolean;
  action: GameAction | null;
  currentBestScore: number;
  strategy: StrategyReport;
  stats: SearchStats;
}
interface Scenario { opponentRack: Letter[]; drawOrder: Letter[] }

/** Deterministic samples use only information available to the AI as a player. */
export function sampleHiddenScenario(position: AiDecisionPosition, sample: number): Scenario {
  const unseen = { ...INITIAL_COUNTS };
  for (const letter of position.board) if (letter) unseen[letter]--;
  for (const letter of position.rack) unseen[letter]--;
  const pool: Letter[] = [];
  for (const letter of LETTERS) {
    if (unseen[letter] < 0) throw new Error('Inconsistent public tile inventory');
    if (!isVowel(letter)) for (let i = 0; i < unseen[letter]; i++) pool.push(letter);
  }
  if (!Number.isInteger(position.opponentRackSize) || position.opponentRackSize < 0 || position.opponentRackSize > 10 || pool.length !== position.opponentRackSize + position.consonantsRemaining)
    throw new Error('Inconsistent public consonant inventory');
  let state = createHash('sha256').update(`bestword-ai-v1:${position.gameId}:${position.revision}:${sample}`).digest().readUInt32LE(0) || 0x6d2b79f5;
  const random = (limit: number): number => {
    const bound = 0x1_0000_0000 - (0x1_0000_0000 % limit);
    let value: number;
    do { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; value = state >>> 0; } while (value >= bound);
    return value % limit;
  };
  for (let i = pool.length - 1; i > 0; i--) { const other = random(i + 1); [pool[i], pool[other]] = [pool[other]!, pool[i]!]; }
  return { opponentRack: pool.slice(0, position.opponentRackSize), drawOrder: pool.slice(position.opponentRackSize) };
}

/** Exact immediate placement; optional paired two-own-turn estimates only choose PLAY versus NO WORDS. */
export function decideMove(position: AiDecisionPosition, lexicons: { play: SearchLexicon; full: SearchLexicon }, options: DecisionOptions): DecisionResult {
  const now = options.now ?? (() => performance.now());
  const started = now(), deadline = started + Math.max(0, options.remainingClockMs);
  const cancelled = (): boolean => Boolean(options.shouldCancel?.()) || now() >= deadline;
  const current = findBestMove(position, lexicons.play, { shouldCancel: cancelled });
  const stats = { ...current.stats };
  const strategy: StrategyReport = { reason: 'best-placement', completedPairs: 0, improvements: [], meanImprovement: 0, requiredImprovement: Math.max(10, current.score * 0.1) };
  if (!current.complete) return { complete: false, action: null, currentBestScore: current.score, strategy: { ...strategy, reason: 'cancelled' }, stats };
  const canNoWords = position.drawnThisTurn > 0 && !position.opponentPassed;
  if (!current.move) return { complete: true, action: { type: canNoWords ? 'NO_WORDS' : 'PASS' }, currentBestScore: 0, strategy: { ...strategy, reason: 'no-legal-move' }, stats };
  const play = current.move;
  const canAccumulate = position.rack.length < 10 && position.consonantsRemaining > 0;
  const optionalDeadline = Math.min(deadline - 500, now() + Math.max(0, Math.min(1500, options.rolloutBudgetMs ?? 1500)));
  const stopOptional = (): boolean => cancelled() || now() >= optionalDeadline;
  if (!canNoWords || !canAccumulate || stopOptional()) {
    const stopped = cancelled();
    return { complete: !stopped, action: stopped ? null : play, currentBestScore: current.score, strategy: stopped ? { ...strategy, reason: 'cancelled' } : strategy, stats };
  }
  const search = (state: AiPosition, dictionary: SearchLexicon) => {
    const result = findBestMove(state, dictionary, { shouldCancel: stopOptional });
    stats.visited += result.stats.visited; stats.candidates += result.stats.candidates; stats.elapsedMs += result.stats.elapsedMs;
    return result;
  };
  function branch(scenario: Scenario, waiting: boolean): number | null {
    let own = waiting ? position : applyPlacement(position, play);
    const bag = [...scenario.drawOrder];
    let opponentRack = [...scenario.opponentRack];
    const draw = (rack: readonly Letter[]): Letter[] => {
      const result = [...rack];
      const count = Math.min(2, 10 - result.length, bag.length);
      for (let i = 0; i < count; i++) result.push(bag.pop()!);
      return result;
    };
    opponentRack = draw(opponentRack);
    const opponent: AiPosition = { ...own, rack: opponentRack };
    const reply = search(opponent, lexicons.full);
    if (!reply.complete) return null;
    if (reply.move) {
      const after = applyPlacement(opponent, reply.move);
      own = { ...after, rack: own.rack };
    }
    // A no-move opponent either skips or passes; either way the AI receives its next normal draw.
    own = { ...own, rack: draw(own.rack) };
    const next = search(own, lexicons.play);
    if (!next.complete) return null;
    return (waiting ? 0 : current.score) - reply.score + next.score;
  }
  for (let sample = 0; sample < 4 && !stopOptional(); sample++) {
    const scenario = sampleHiddenScenario(position, sample);
    const played = branch(scenario, false);
    if (played === null) break;
    const waited = branch(scenario, true);
    if (waited === null) break;
    strategy.improvements.push(waited - played);
  }
  strategy.completedPairs = strategy.improvements.length;
  strategy.meanImprovement = strategy.completedPairs === 0 ? 0 : strategy.improvements.reduce((sum, improvement) => sum + improvement, 0) / strategy.completedPairs;
  const favorWait = strategy.improvements.filter(improvement => improvement > 0).length;
  const wait = strategy.completedPairs >= 2 && strategy.meanImprovement >= strategy.requiredImprovement && favorWait >= Math.ceil(strategy.completedPairs * 0.75);
  if (cancelled()) return { complete: false, action: null, currentBestScore: current.score, strategy: { ...strategy, reason: 'cancelled' }, stats };
  if (wait) strategy.reason = 'strategic-no-words';
  return { complete: true, action: wait ? { type: 'NO_WORDS' } : play, currentBestScore: current.score, strategy, stats };
}
