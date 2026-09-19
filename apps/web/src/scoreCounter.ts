export const SCORE_ANIMATION_MS = 900;

export interface AnimationScheduler {
  now(): number;
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
}

/** Presentation only: the authoritative score is never changed by animation. */
export function createScoreCounter(initial: number, display: (value: number) => void, scheduler: AnimationScheduler) {
  let value = initial;
  let target = initial;
  let frame: number | null = null;
  const cancel = () => {
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
  };
  return {
    cancel,
    update(next: number, animate: boolean) {
      if (animate && next === target) return;
      cancel();
      target = next;
      if (!animate || next <= value) {
        value = next;
        display(value);
        return;
      }
      const from = value;
      const started = scheduler.now();
      const tick = (time: number) => {
        const progress = Math.min(1, Math.max(0, (time - started) / SCORE_ANIMATION_MS));
        // Floor keeps the last integer for completion, with no early overshoot.
        value = progress === 1 ? next : Math.floor(from + (next - from) * (1 - (1 - progress) ** 3));
        display(value);
        frame = progress < 1 ? scheduler.request(tick) : null;
      };
      frame = scheduler.request(tick);
    },
  };
}
