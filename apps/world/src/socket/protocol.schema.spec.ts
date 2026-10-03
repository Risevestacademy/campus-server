import { describe, expect, it } from 'vitest';

import { protocolJsonSchema } from './protocol.schema.js';

describe('protocol.schema.json', () => {
  /**
   * The frontend generates its types from the committed file. If this fails,
   * protocol.ts changed without regenerating it: run
   * `pnpm --filter world protocol:schema` and commit the result, and tell
   * the frontend the protocol moved.
   */
  it('matches the protocol in the code', async () => {
    const json = `${JSON.stringify(protocolJsonSchema(), null, 2)}\n`;

    await expect(json).toMatchFileSnapshot('../../protocol.schema.json');
  });

  it('names every message and shared type, so generated types get real names', () => {
    const { definitions } = protocolJsonSchema() as {
      definitions: Record<string, unknown>;
    };

    expect(Object.keys(definitions).sort()).toEqual(
      [
        'ClientMessage',
        'PingMessage',
        'MoveMessage',
        'ServerMessage',
        'WelcomeMessage',
        'PongMessage',
        'SnapshotMessage',
        'JoinedMessage',
        'LeftMessage',
        'MovedMessage',
        'MoveResultMessage',
        'ErrorMessage',
        'Player',
        'Direction',
        'MoveOutcome',
      ].sort(),
    );
  });
});
