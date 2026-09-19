import type { GamePage, GameSummary } from '@bestword/contracts';

export interface HistoryList { items: GameSummary[]; nextCursor: string | null; loaded: boolean }
export const emptyHistory = (): HistoryList => ({ items: [], nextCursor: null, loaded: false });
const merge = (first: GameSummary[], second: GameSummary[]) => {
  const ids = new Set(first.map(item => item.id));
  return [...first, ...second.filter(item => !ids.has(item.id))];
};

/** Refresh adds new games without replacing already expanded pages or their cursor. */
export function refreshHistory(previous: HistoryList, page: GamePage): HistoryList {
  return { items: merge(page.items, previous.items), nextCursor: previous.loaded ? previous.nextCursor : page.nextCursor, loaded: true };
}
export function appendHistory(previous: HistoryList, cursor: string, page: GamePage): HistoryList {
  if (previous.nextCursor !== cursor) return previous;
  return { items: merge(previous.items, page.items), nextCursor: page.nextCursor, loaded: true };
}

/** Bridge a burst of more than 50 completions before joining the retained list. */
export async function freshHistory(known: GameSummary[], read: (cursor?: string) => Promise<GamePage>, current: () => boolean): Promise<GamePage> {
  const ids = new Set(known.map(item => item.id));
  const visited = new Set<string>();
  let page = await read(), items = page.items;
  const firstCursor = page.nextCursor;
  while (current() && ids.size > 0 && !items.some(item => ids.has(item.id)) && page.nextCursor && !visited.has(page.nextCursor)) {
    visited.add(page.nextCursor);
    page = await read(page.nextCursor);
    items = merge(items, page.items);
  }
  return { items, nextCursor: firstCursor };
}
