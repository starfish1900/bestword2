import { describe, expect, it } from 'vitest';
import type { GameSummary } from '@bestword/contracts';
import { appendHistory, emptyHistory, freshHistory, refreshHistory } from './historyPaging';
const games = (...ids: string[]) => ids.map(id => ({ id } as GameSummary));
describe('recent games pagination', () => {
  it('preserves expanded rows and the deepest cursor across refresh and delayed page replies', () => {
    let state = refreshHistory(emptyHistory(), { items: games('b', 'c'), nextCursor: 'after-c' });
    state = refreshHistory(state, { items: games('a', 'b'), nextCursor: 'after-b' });
    state = appendHistory(state, 'after-c', { items: games('d', 'e'), nextCursor: 'after-e' });
    state = refreshHistory(state, { items: games('z', 'a'), nextCursor: 'after-a' });
    expect(state.items.map(game => game.id)).toEqual(['z', 'a', 'b', 'c', 'd', 'e']);
    expect(state.nextCursor).toBe('after-e');
    expect(appendHistory(state, 'after-c', { items: games('stale'), nextCursor: null })).toBe(state);
  });
  it('retains exhaustion and updates existing rows without duplicates', () => {
    let state = refreshHistory(emptyHistory(), { items: games('a'), nextCursor: null });
    state = refreshHistory(state, { items: [{ ...games('a')[0]!, spectatorCount: 2 }], nextCursor: 'ignored' });
    expect(state.items).toHaveLength(1); expect(state.items[0]!.spectatorCount).toBe(2); expect(state.nextCursor).toBeNull();
  });
  it('fetches intermediate pages when a busy lobby publishes more than one page', async () => {
    const cursors: Array<string | undefined> = [];
    const page = await freshHistory(games('old'), async cursor => {
      cursors.push(cursor);
      return cursor ? { items: games('middle', 'old'), nextCursor: 'older' } : { items: games('new'), nextCursor: 'middle' };
    }, () => true);
    expect(cursors).toEqual([undefined, 'middle']); expect(page.items.map(game => game.id)).toEqual(['new', 'middle', 'old']);
  });
  it('stops obsolete refreshes before requesting another page', async () => {
    let calls = 0;
    await freshHistory(games('old'), async () => { calls++; return { items: games('new'), nextCursor: 'next' }; }, () => false);
    expect(calls).toBe(1);
  });
});
