import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, setConnected, startIfReady, projectGame, INITIAL_COUNTS } from '@bestword/engine';
import { Gaddag } from '@bestword/lexicon';
import { isVowel, type Letter } from '@bestword/contracts';
import { decideMove, findBestMove, sampleHiddenScenario, type AiDecisionPosition, type SearchLexicon } from '../src/index.js';
import { dictionary, fixture } from './helpers.js';

const full = Gaddag.load(readFileSync(new URL('../../../data/lexicon.bin', import.meta.url)));
const easy = Gaddag.load(readFileSync(new URL('../../../data/easy.gaddag', import.meta.url)), { decodeSeeds: false });
function opening(seed: number): AiDecisionPosition {
  let random = seed;
  let state = createGame({ id: `fixture-${seed}`, players: [{ id: 'bot', username: 'Bot' }, { id: 'human', username: 'Human' }], minutes: 5, lexiconVersion: full.sha256, seedWords: full.seedWords, now: 0, randomInt: max => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % max; }, firstSeat: 0 }, full);
  state = setConnected(state, 0, true, 0); state = setConnected(state, 1, true, 0); state = startIfReady(state, 3000);
  const view = projectGame(state, 0, 3000);
  return { board: view.game.board, rack: view.you!.rack, vowels: view.game.vowelsRemaining, principalHistory: view.game.principalHistory, gameId: state.id, revision: state.revision,
    opponentRackSize: view.game.players[1].rackSize, consonantsRemaining: view.game.consonantsRemaining, drawnThisTurn: view.you!.drawnThisTurn, opponentPassed: false };
}
const complete = { remainingClockMs: 300_000, now: () => 0 };
describe('paired lookahead NO WORDS policy', () => {
  it('waits in a fixed real opening despite an available 54-point move', () => {
    const result = decideMove(opening(1), { play: easy, full }, complete);
    expect(result.complete).toBe(true); expect(result.action).toEqual({ type: 'NO_WORDS' });
    expect(result.currentBestScore).toBe(54);
    expect(result.strategy).toMatchObject({ reason: 'strategic-no-words', completedPairs: 4, improvements: [17, 4, 177, -26], meanImprovement: 43 });
  });
  it('plays the exact current best when lookahead favors taking points', () => {
    const position = opening(2), current = findBestMove(position, easy);
    const result = decideMove(position, { play: easy, full }, complete);
    expect(result.action).toEqual(current.move); expect(result.currentBestScore).toBe(66);
    expect(result.strategy).toMatchObject({ reason: 'best-placement', completedPairs: 4, improvements: [-29, -24, 39, -19] });
  });
  it.each([{ drawnThisTurn: 0 }, { opponentPassed: true }])('never strategically waits when ineligible: %j', change => {
    const position = { ...opening(1), ...change };
    const result = decideMove(position, { play: easy, full }, complete);
    expect(result.action?.type).toBe('PLACE_WORD'); expect(result.strategy.completedPairs).toBe(0);
  });
  it.each(['full-rack', 'empty-bag'] as const)('plays the exact best without rollout when consonants cannot accumulate: %s', reason => {
    const position = opening(1);
    if (reason === 'full-rack') position.rack = [...position.rack, 'B', 'C', 'D', 'F', 'G', 'H', 'J', 'K'];
    else position.consonantsRemaining = 0;
    // This is a post-draw state: NO WORDS can still be legal after filling the rack or emptying the bag.
    expect(position.drawnThisTurn).toBeGreaterThan(0);
    const current = findBestMove(position, easy);
    expect(current.move).not.toBeNull();
    const noRollout: SearchLexicon = { root: 0, has: () => { throw new Error('Optional rollout must not run'); }, next: () => { throw new Error('Optional rollout must not run'); }, isTerminal: () => false, transitionMask: () => { throw new Error('Optional rollout must not run'); } };
    const result = decideMove(position, { play: easy, full: noRollout }, complete);
    expect(result.action).toEqual(current.move);
    expect(result.strategy.completedPairs).toBe(0);
    expect(result.strategy.reason).toBe('best-placement');
  });
  it('falls back to exact current best with zero optional budget or the 500 ms clock guard', () => {
    const position = opening(1), best = findBestMove(position, easy).move;
    expect(decideMove(position, { play: easy, full }, { ...complete, rolloutBudgetMs: 0 }).action).toEqual(best);
    expect(decideMove(position, { play: easy, full }, { ...complete, remainingClockMs: 499 }).action).toEqual(best);
  });
  it('discards an incomplete paired rollout and retains the exact current placement', () => {
    const position = opening(1); let clock = 0;
    const interrupting: SearchLexicon = { root: full.root, next: full.next.bind(full), isTerminal: full.isTerminal.bind(full), transitionMask: full.transitionMask.bind(full), has: word => { clock = 1600; return full.has(word); } };
    const result = decideMove(position, { play: easy, full: interrupting }, { remainingClockMs: 300_000, now: () => clock });
    expect(result.complete).toBe(true); expect(result.strategy.completedPairs).toBe(0); expect(result.strategy.improvements).toEqual([]);
    expect(result.action).toEqual(findBestMove(position, easy).move);
  });
  it('never returns a partial action when mandatory search or a running rollout is externally cancelled', () => {
    const position = opening(1);
    expect(decideMove(position, { play: easy, full }, { ...complete, shouldCancel: () => true })).toMatchObject({ complete: false, action: null });
    let cancelled = false;
    const interrupting: SearchLexicon = { root: full.root, next: full.next.bind(full), isTerminal: full.isTerminal.bind(full), transitionMask: full.transitionMask.bind(full), has: word => { cancelled = true; return full.has(word); } };
    expect(decideMove(position, { play: easy, full: interrupting }, { ...complete, shouldCancel: () => cancelled })).toMatchObject({ complete: false, action: null });
  });
  it('uses NO WORDS for proven no move only while legal, otherwise PASS', () => {
    const position = fixture([], 'QQ'); const graph = dictionary(['CAT']);
    expect(decideMove(position, { play: graph, full: graph }, complete).action).toEqual({ type: 'NO_WORDS' });
    expect(decideMove({ ...position, drawnThisTurn: 0 }, { play: graph, full: graph }, complete).action).toEqual({ type: 'PASS' });
    expect(decideMove({ ...position, opponentPassed: true }, { play: graph, full: graph }, complete).action).toEqual({ type: 'PASS' });
    expect(decideMove({ ...position, consonantsRemaining: 0 }, { play: graph, full: graph }, complete).action).toEqual({ type: 'NO_WORDS' });
    expect(decideMove({ ...position, rack: Array<Letter>(10).fill('Q') }, { play: graph, full: graph }, complete).action).toEqual({ type: 'NO_WORDS' });
  });
  it('samples only unseen consonants with deterministic draws and public rack sizes', () => {
    const position = opening(1); position.opponentRackSize = 4; position.consonantsRemaining -= 4;
    const sample = sampleHiddenScenario(position, 0);
    expect(sample).toEqual(sampleHiddenScenario(position, 0)); expect(sample).not.toEqual(sampleHiddenScenario(position, 1));
    expect(sample.opponentRack).toHaveLength(4); expect(sample.drawOrder).toHaveLength(position.consonantsRemaining);
    const counts = { ...INITIAL_COUNTS };
    for (const letter of [...position.board, ...position.rack, ...sample.opponentRack, ...sample.drawOrder]) if (letter) counts[letter]--;
    for (const [letter, remaining] of Object.entries(counts)) if (!isVowel(letter as Letter)) expect(remaining).toBe(0);
    expect([...sample.opponentRack, ...sample.drawOrder].some(isVowel)).toBe(false);
    Object.defineProperty(position, 'consonantDrawOrder', { get() { throw new Error('Private future draws accessed'); } });
    Object.defineProperty(position, 'opponentRack', { get() { throw new Error('Private opponent rack accessed'); } });
    expect(() => decideMove(position, { play: easy, full }, complete)).not.toThrow();
  });
});
