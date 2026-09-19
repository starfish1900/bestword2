import { describe, expect, it } from 'vitest';
import { createScoreCounter, type AnimationScheduler } from './scoreCounter';

function setup(initial = 10) {
  let time = 0, id = 0;
  const frames = new Map<number, (time: number) => void>();
  const shown: number[] = [];
  const scheduler: AnimationScheduler = {
    now: () => time,
    request: callback => { frames.set(++id, callback); return id; },
    cancel: key => { frames.delete(key); },
  };
  const counter = createScoreCounter(initial, value => shown.push(value), scheduler);
  const advance = (next: number) => { time = next; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); };
  return { counter, advance, shown, frames };
}

describe('score presentation', () => {
  it('counts whole points monotonically, slows down and reaches the exact score', () => {
    const t = setup(); t.counter.update(1010, true);
    for (let time = 0; time <= 900; time += 150) t.advance(time);
    expect(t.shown[0]).toBe(10); expect(t.shown.at(-1)).toBe(1010);
    const increments = t.shown.slice(1).map((value, i) => value - t.shown[i]!);
    expect(t.shown.every(Number.isInteger)).toBe(true);
    expect(increments.every((value, i) => value > 0 && (i === 0 || value < increments[i - 1]!))).toBe(true);
    expect(t.frames.size).toBe(0);
  });
  it('does not restart after a duplicate score update', () => {
    const t = setup(); t.counter.update(110, true); t.advance(300);
    t.counter.update(110, true); t.advance(900);
    expect(t.shown.at(-1)).toBe(110); expect(t.frames.size).toBe(0);
  });
  it('continues from the displayed value when more points arrive', () => {
    const t = setup(); t.counter.update(110, true); t.advance(300);
    const midway = t.shown.at(-1)!;
    t.counter.update(210, true); t.advance(300);
    expect(t.shown.at(-1)).toBe(midway);
    t.advance(600); expect(t.shown.at(-1)).toBeGreaterThan(midway);
    t.advance(1200); expect(t.shown.at(-1)).toBe(210);
    expect(t.frames.size).toBe(0);
  });
  it('snaps for reduced motion, rewind, or navigation, cancelling pending frames', () => {
    const t = setup(); t.counter.update(110, true); t.advance(300);
    t.counter.update(110, false); expect(t.shown.at(-1)).toBe(110);
    expect(t.frames.size).toBe(0);
    t.counter.update(0, true); expect(t.shown.at(-1)).toBe(0);
    t.advance(900); expect(t.shown.at(-1)).toBe(0);
  });
  it('cancels callbacks when a score leaves the screen', () => {
    const t = setup(); t.counter.update(110, true); t.counter.cancel();
    t.advance(1000); expect(t.shown).toEqual([]);
  });
});
