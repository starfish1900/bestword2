import { describe, expect, it } from 'vitest';
import { authHref, requestedReplayPosition, safeReturnTo } from './authNavigation';
const game = '/game/15453d0c-0d68-4043-8336-9068cbd08aeb';
describe('authentication return destinations', () => {
  it('preserves a replay position and AI lobby selections through sign-in', () => {
    expect(safeReturnTo(`${game}?replay=1&move=42`)).toBe(`${game}?replay=1&move=42`);
    expect(authHref('sign-in', `${game}?replay=1&move=42`)).toBe(`/sign-in?returnTo=${encodeURIComponent(`${game}?replay=1&move=42`)}`);
    expect(safeReturnTo('/?opponent=ai&difficulty=hard&minutes=25')).toBe('/?opponent=ai&difficulty=hard&minutes=25');
  });
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/sign-in', '/api/auth/logout'])('rejects unsafe or unrelated destinations %s', value => {
    expect(safeReturnTo(value)).toBeNull();
  });
  it('discards unrelated parameters and malformed positions', () => {
    expect(safeReturnTo(`${game}?replay=1&move=-1&next=https://evil.example`)).toBe(`${game}?replay=1`);
    expect(requestedReplayPosition(new URLSearchParams('move=17'))).toBe(17);
    expect(requestedReplayPosition(new URLSearchParams('move=Infinity'))).toBe(0);
  });
});
