/** Only known local application destinations are accepted after authentication. */
export function safeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, 'https://bestword.invalid');
    if (url.origin !== 'https://bestword.invalid' || !/^\/(?:game\/[a-f0-9-]{36})?$/i.test(url.pathname)) return null;
    const query = new URLSearchParams();
    if (url.pathname.startsWith('/game/')) {
      if (url.searchParams.has('replay')) query.set('replay', '1');
      const move = url.searchParams.get('move');
      if (move !== null && /^\d{1,6}$/.test(move)) query.set('move', String(Number(move)));
    } else {
      if (url.searchParams.get('opponent') === 'ai') query.set('opponent', 'ai');
      const difficulty = url.searchParams.get('difficulty'), minutes = url.searchParams.get('minutes');
      if (difficulty && ['easy', 'medium', 'hard'].includes(difficulty)) query.set('difficulty', difficulty);
      if (minutes && ['5', '15', '25'].includes(minutes)) query.set('minutes', minutes);
    }
    return `${url.pathname}${query.size ? `?${query}` : ''}`;
  } catch { return null; }
}
export function authHref(kind: 'sign-in' | 'sign-up', destination: string): string {
  const safe = safeReturnTo(destination);
  return `/${kind}${safe ? `?returnTo=${encodeURIComponent(safe)}` : ''}`;
}
export function requestedReplayPosition(params: URLSearchParams): number {
  const value = params.get('move');
  return value && /^\d{1,6}$/.test(value) ? Number(value) : 0;
}
