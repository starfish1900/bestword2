import type { CommandReply, GameCommand } from '@bestword/contracts';

export function pendingAfterReply(command: GameCommand, reply: CommandReply): GameCommand | null {
  // Recovery can follow an ambiguous COMMIT: retry the same receipt, even if the move was accepted.
  return !reply.ok && reply.error.code === 'SERVICE_RECOVERING' ? command : null;
}
