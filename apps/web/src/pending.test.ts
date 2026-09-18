import { describe, expect, it } from 'vitest';
import type { CommandReply, GameCommand, GameView } from '@bestword/contracts';
import { pendingAfterReply } from './pending';

const command: GameCommand = {
  commandId: '7bb3d860-3076-47c5-982e-d24976814424',
  gameId: '76aaec9e-3e60-4f37-bcaa-3d096bd41935',
  expectedRevision: 7,
  action: { type: 'PLACE_WORD', row: 2, column: 0, direction: 'H', word: 'CARE' },
};
const view: GameView = {
  game: {
    id: command.gameId, revision: 8, rulesVersion: 'bestword-1', lexiconVersion: 'test',
    status: 'active', board: Array(225).fill(null),
    players: [
      { id: 'first', username: 'First', score: 12, rackSize: 2, passed: false, connected: true },
      { id: 'second', username: 'Second', score: 0, rackSize: 2, passed: false, connected: true },
    ],
    activeSeat: 1, minutes: 5, clocksMs: [300000, 300000], turnStartedAt: 1000,
    turnDeadlineAt: 301000, startsAt: null, serverTime: 1000,
    vowelsRemaining: { A: 16, E: 24, I: 16, O: 13, U: 13, Y: 8 }, consonantsRemaining: 173,
    principalHistory: [], moves: [], disconnectDeadlines: [null, null], pause: null,
    result: null, spectatorCount: 0,
  },
  you: { seat: 0, rack: ['B', 'C'], drawnThisTurn: 2, canNoWords: true },
};

describe('pending command receipts', () => {
  it('retains the exact command through recovery retries, then clears it after acceptance', () => {
    const recovery: CommandReply = { ok: false, error: { code: 'SERVICE_RECOVERING', message: 'Reconnecting.' } };
    const pending = pendingAfterReply(command, recovery);
    expect(pending).toBe(command);
    // The value persisted for reload and the value sent on retry must retain every command field.
    expect(JSON.stringify(pending)).toBe(JSON.stringify(command));
    expect(pendingAfterReply(pending!, recovery)).toBe(command);
    expect(pendingAfterReply(pending!, { ok: true, view, acceptedRevision: 8 })).toBeNull();
  });

  it.each(['INVALID_WORD', 'STALE_REVISION', 'NOT_YOUR_TURN', 'INVALID_REQUEST'])(
    'clears a definitive %s rejection so the player can edit and submit a new command',
    code => {
      expect(pendingAfterReply(command, { ok: false, error: { code, message: 'Rejected.' }, view })).toBeNull();
    },
  );
});
