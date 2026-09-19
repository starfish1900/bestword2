import { test, expect, type Page } from '@playwright/test';
import type { GameView } from '@bestword/contracts';
import { account, enterPlacement, findLegalPlacement } from './helpers';

interface ScoreSample { at: number; target: number; text: string }
interface ScoreRecording { samples: ScoreSample[]; stop: () => void }
type RecordedWindow = Window & { bestwordScoreRecording?: ScoreRecording };

// Observe the rendered score through every React commit, without changing timers,
// component state, sockets, or responses from the real game server.
function recordScore(username: string) {
  const host = window as RecordedWindow;
  host.bestwordScoreRecording?.stop();
  const samples: ScoreSample[] = [];
  let last = '';
  const capture = () => {
    const score = document.querySelector(`.animated-score[data-player="${username}"]`);
    if (!score) return;
    const text = score.querySelector('.score-value')?.textContent?.trim() ?? '', target = Number(score.getAttribute('data-score'));
    const key = `${target}:${text}`;
    if (key !== last) { samples.push({ at: performance.now(), target, text }); last = key; }
  };
  const observer = new MutationObserver(capture);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  host.bestwordScoreRecording = { samples, stop: () => observer.disconnect() };
  capture();
}

const scoreFor = (page: Page, username: string) => page.locator(`.animated-score[data-player="${username}"]`);
const samplesFor = (page: Page) => page.evaluate(() => (window as RecordedWindow).bestwordScoreRecording?.samples ?? []);

async function expectCountUp(page: Page, username: string, from: number, target: number) {
  const score = scoreFor(page, username);
  await expect(score).toHaveAttribute('data-score', String(target));
  // Verify the browser's actual accessibility tree exposes the confirmed score.
  expect(await score.ariaSnapshot()).toContain(`${username} score ${target}`);
  await expect(score.locator('.score-value')).toHaveText(String(target));
  const samples = await samplesFor(page), changed = samples.filter(sample => sample.target === target);
  expect(changed.length).toBeGreaterThan(1);
  const values = changed.map(sample => { expect(sample.text).toMatch(/^\d+$/); return Number(sample.text); });
  expect(values.some(value => value > from && value < target)).toBe(true);
  expect(values.at(-1)).toBe(target);
  for (let index = 0; index < values.length; index++) {
    expect(values[index]).toBeGreaterThanOrEqual(index ? values[index - 1]! : from);
    expect(values[index]).toBeLessThanOrEqual(target);
  }
  // Assistive technology gets the confirmed score, not animation frames.
  await expect(score.locator('.score-value')).toHaveAttribute('aria-hidden', 'true');
  expect(await score.ariaSnapshot()).toContain(`${username} score ${target}`);
  return samples;
}

async function expectImmediate(page: Page, username: string, target: number) {
  const score = scoreFor(page, username);
  await expect(score).toHaveAttribute('data-score', String(target));
  await expect(score.locator('.score-value')).toHaveText(String(target));
  expect(await score.ariaSnapshot()).toContain(`${username} score ${target}`);
  const samples = await samplesFor(page), changed = samples.filter(sample => sample.target === target);
  expect(changed.length).toBeGreaterThan(0);
  // Inspect every captured render: an eventual match alone could hide an animation.
  expect(changed.every(sample => sample.text === String(target))).toBe(true);
  return samples;
}

test('real scores count up for players and spectators, with immediate reduced-motion and replay scrubs', async ({ browser, baseURL }, testInfo) => {
  const origin = baseURL!, prefix = `BW${process.env.BESTWORD_E2E_RUN_ID}`.slice(0, 13);
  const alice = await account(browser, origin, `${prefix}A`), bob = await account(browser, origin, `${prefix}B`);
  const spectator = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  const watch = await spectator.newPage(), errors: string[] = [];
  for (const page of [alice.page, bob.page, watch]) page.on('pageerror', error => errors.push(error.message));
  const evidence: Record<string, ScoreSample[]> = {};
  try {
    for (const page of [alice.page, bob.page]) await page.emulateMedia({ reducedMotion: 'no-preference' });
    await alice.page.getByRole('button', { name: 'Create a game', exact: true }).click();
    await expect(alice.page.locator('.your-seek')).toBeVisible();
    await bob.page.locator('.seek-row').filter({ hasText: `${prefix}A` }).getByRole('button', { name: 'Join', exact: true }).click();
    await expect(bob.page).toHaveURL(/\/game\/[\da-f-]+$/);
    await expect(alice.page).toHaveURL(bob.page.url());
    const gameId = bob.page.url().split('/').at(-1)!;
    const read = async (player = alice): Promise<GameView> => {
      const response = await player.context.request.get(`/api/games/${gameId}`);
      expect(response.ok()).toBe(true);
      return response.json() as Promise<GameView>;
    };
    await expect.poll(async () => { const view = await read(); return view.game.status === 'active' && view.game.startsAt === null; }).toBe(true);
    const initial = await read(), actor = initial.you?.seat === initial.game.activeSeat ? alice : bob, other = actor === alice ? bob : alice;
    const actorView = await read(actor), actorSeat = actorView.you!.seat, actorName = actorView.game.players[actorSeat].username;
    const otherView = await read(other), otherSeat = otherView.you!.seat, otherName = otherView.game.players[otherSeat].username;
    await expect(actor.page.getByRole('heading', { name: 'Your move', exact: true })).toBeVisible();
    await watch.goto(`/game/${gameId}`);
    await expect(watch.locator('.game-format')).toContainText('Spectating');
    await expect(scoreFor(watch, actorName).locator('.score-value')).toHaveText('0');
    await actor.page.evaluate(recordScore, actorName);
    await watch.evaluate(recordScore, actorName);

    const firstPlacement = await findLegalPlacement(actorView);
    await enterPlacement(actor.page, firstPlacement);
    await expect.poll(async () => (await read()).game.moves.length).toBe(1);
    const first = await read(), firstScore = first.game.players[actorSeat].score;
    expect(firstScore).toBeGreaterThan(1);
    evidence.playerMove = await expectCountUp(actor.page, actorName, 0, firstScore);
    evidence.spectatorMove = await expectCountUp(watch, actorName, 0, firstScore);

    await expect(other.page.getByRole('heading', { name: 'Your move', exact: true })).toBeVisible();
    await other.page.emulateMedia({ reducedMotion: 'reduce' });
    await other.page.evaluate(recordScore, otherName);
    const secondPlacement = await findLegalPlacement(await read(other));
    await enterPlacement(other.page, secondPlacement);
    await expect.poll(async () => (await read()).game.moves.length).toBe(2);
    const second = await read(), secondScore = second.game.players[otherSeat].score;
    expect(secondScore).toBeGreaterThan(1);
    evidence.reducedMotion = await expectImmediate(other.page, otherName, secondScore);

    // The observer starts in the new document before React mounts its first score.
    await actor.page.addInitScript(recordScore, actorName);
    await actor.page.reload();
    evidence.reload = await expectImmediate(actor.page, actorName, firstScore);
    for (const player of [actor, other]) {
      await expect(player.page.getByRole('heading', { name: 'Your move', exact: true })).toBeVisible();
      await player.page.getByRole('button', { name: 'Pass forever', exact: true }).click();
      await player.page.getByRole('dialog').getByRole('button', { name: 'Pass forever', exact: true }).click();
    }
    await expect.poll(async () => (await read()).game.status).toBe('finished');
    await expect(watch.locator('.result-card')).toBeVisible();
    await expect(watch.getByRole('link', { name: 'Sign in to replay', exact: true })).toBeVisible();
    await spectator.addCookies(await alice.context.cookies());
    await watch.reload();
    await watch.getByRole('button', { name: 'Explore the replay', exact: true }).click();
    const slider = watch.getByRole('slider', { name: 'Replay move' });
    await expect(slider).toHaveValue('0');
    await expect(scoreFor(watch, actorName).locator('.score-value')).toHaveText('0');

    await watch.evaluate(recordScore, actorName);
    await watch.getByRole('button', { name: 'Next move', exact: true }).click();
    await expect(slider).toHaveValue('1');
    evidence.replayNext = await expectCountUp(watch, actorName, 0, firstScore);

    await watch.evaluate(recordScore, actorName);
    await watch.getByRole('button', { name: 'Previous move', exact: true }).click();
    await expect(slider).toHaveValue('0');
    evidence.replayPrevious = await expectImmediate(watch, actorName, 0);

    // A one-position slider scrub must snap just like a longer jump; only the
    // explicit Next/autoplay actions should animate a forward replay step.
    await watch.evaluate(recordScore, actorName);
    await slider.focus();
    await slider.press('ArrowRight');
    await expect(slider).toHaveValue('1');
    evidence.sliderSingleStep = await expectImmediate(watch, actorName, firstScore);

    await watch.getByRole('button', { name: 'First position', exact: true }).click();
    await expect(slider).toHaveValue('0');
    await watch.evaluate(recordScore, otherName);
    await slider.focus();
    await slider.press('End');
    await expect(slider).toHaveValue('4');
    evidence.sliderJump = await expectImmediate(watch, otherName, secondScore);
    expect(errors).toEqual([]);
    await testInfo.attach('rendered-score-observations', { body: JSON.stringify({ gameId, firstScore, secondScore, evidence }, null, 2), contentType: 'application/json' });
  } finally {
    await alice.context.close();
    await bob.context.close();
    await spectator.close();
  }
});
