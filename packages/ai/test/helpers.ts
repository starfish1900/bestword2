import { INITIAL_COUNTS, type EngineState } from '@bestword/engine';
import { VOWELS, type Board, type Letter, type PlaceWordAction } from '@bestword/contracts';
import type { AiDecisionPosition, AiPosition, SearchLexicon } from '../src/index.js';

/** Unminimized test trie built independently from the production binary reader. */
export function dictionary(words: readonly string[]): SearchLexicon {
  const nodes: { terminal: boolean; edges: Map<string, number> }[] = [{ terminal: false, edges: new Map() }];
  const language = new Set(words);
  for (const word of language) for (let split = 1; split <= word.length; split++) {
    const transformed = [...word.slice(0, split)].reverse().join('') + (split < word.length ? '+' + word.slice(split) : '');
    let node = 0;
    for (const letter of transformed) {
      let next = nodes[node]!.edges.get(letter);
      if (next === undefined) { next = nodes.length; nodes.push({ terminal: false, edges: new Map() }); nodes[node]!.edges.set(letter, next); }
      node = next;
    }
    nodes[node]!.terminal = true;
  }
  return { root: 0, has: word => language.has(word), next: (node, label) => nodes[node]!.edges.get(label) ?? null, isTerminal: node => nodes[node]!.terminal,
    transitionMask: node => [...nodes[node]!.edges.keys()].reduce((mask, label) => mask | (1 << (label === '+' ? 0 : label.charCodeAt(0) - 64)), 0) };
}
export function action(notation: string, word: string): PlaceWordAction {
  const horizontal = /^\d/.test(notation);
  const match = (horizontal ? /^(\d+)([A-O])$/ : /^([A-O])(\d+)$/).exec(notation)!;
  return { type: 'PLACE_WORD', row: Number(match[horizontal ? 1 : 2]) - 1, column: match[horizontal ? 2 : 1]!.charCodeAt(0) - 65, direction: horizontal ? 'H' : 'V', word };
}
export function fixture(existing: [string, string][], rack: string, history: string[] = []): AiDecisionPosition {
  const board: Board = Array<Letter | null>(225).fill(null);
  for (const [notation, word] of existing) {
    const move = action(notation, word);
    for (let i = 0; i < word.length; i++) board[(move.row + (move.direction === 'V' ? i : 0)) * 15 + move.column + (move.direction === 'H' ? i : 0)] = word[i] as Letter;
  }
  const counts = { ...INITIAL_COUNTS };
  for (const letter of [...board, ...rack as Iterable<Letter>]) if (letter) counts[letter]--;
  return { board, rack: [...rack] as Letter[], vowels: Object.fromEntries(VOWELS.map(letter => [letter, counts[letter]])) as AiPosition['vowels'], principalHistory: history,
    gameId: 'ai-fixture', revision: 1, opponentRackSize: 0, consonantsRemaining: Object.entries(counts).reduce((sum, [letter, count]) => sum + (VOWELS.includes(letter as typeof VOWELS[number]) ? 0 : count), 0), drawnThisTurn: 2, opponentPassed: false };
}
export function engineState(position: AiPosition): EngineState {
  return { board: [...position.board], players: [{ rack: [...position.rack] }, { rack: [] }], bag: { ...INITIAL_COUNTS, ...position.vowels }, principalHistory: [...position.principalHistory] } as EngineState;
}
export const key = (move: PlaceWordAction): string => `${move.word}:${move.direction}:${String(move.row).padStart(2, '0')}:${String(move.column).padStart(2, '0')}`;
