import { compile } from 'json-schema-to-typescript';
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

  /**
   * What the frontend actually gets from the command docs/world-protocol.md
   * gives it, run with its defaults. A type the generator does not reach is
   * a type the client has to copy by hand, which is how the close lists
   * nearly went missing.
   */
  it('gives json-schema-to-typescript, as documented, every type a client needs', async () => {
    const generated = await compile(
      protocolJsonSchema() as Parameters<typeof compile>[0],
      'WorldProtocol',
      { bannerComment: '' },
    );

    for (const type of [
      'ClientMessage',
      'ServerMessage',
      'CloseCode',
      'CloseReason',
    ]) {
      expect(generated).toMatch(new RegExp(`export type ${type} =`));
    }
    expect(generated).toContain('"no_token"');
    expect(generated).toContain('| 4000');
    // The message unions are as they were: nothing about closing joins them.
    const serverUnion = /export type ServerMessage =([^;]+);/.exec(
      generated,
    )?.[1];
    expect(serverUnion).not.toMatch(/Close/);
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
        'SetStatusMessage',
        'SetLockMessage',
        'RequestEntryMessage',
        'WithdrawEntryRequestMessage',
        'AnswerEntryRequestMessage',
        'ActiveMessage',
        'ServerMessage',
        'WelcomeMessage',
        'PongMessage',
        'SnapshotMessage',
        'JoinedMessage',
        'AppearanceMessage',
        'LeftMessage',
        'StatusChangedMessage',
        'SpaceChangedMessage',
        'CallMessage',
        'NearbyMessage',
        'LockChangedMessage',
        'LockableSpacesMessage',
        'EntryRequestedMessage',
        'EntryRequestEndedMessage',
        'ReplacedMessage',
        'MovedMessage',
        'MoveResultMessage',
        'ErrorMessage',
        'Player',
        'Avatar',
        'Call',
        'Direction',
        'MoveOutcome',
        'EntryRequestOutcome',
        'CloseReason',
        'CloseCode',
        'Status',
      ].sort(),
    );
  });
});
