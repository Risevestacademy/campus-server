import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { Connections, type Connection } from './connections.js';

let opened = 0;

/** A connection holding one seat. Only the fields the registry reads matter. */
function connection(userId: string, cohortId: string): Connection {
  opened += 1;
  return {
    id: `connection-${opened}`,
    userId,
    email: `${userId}@example.com`,
    cohortId,
    appearance: { displayName: null, spriteKey: null },
    spaceKey: '_default',
    socket: {} as WebSocket,
    expiresAt: new Date(0),
    openedAt: opened,
    epoch: 0,
    alive: true,
  };
}

describe('Connections', () => {
  it('keeps one account’s seats in two cohorts apart', () => {
    const connections = new Connections();
    const frontend = connection('ada', 'frontend');
    const backend = connection('ada', 'backend');
    connections.add(frontend);
    connections.add(backend);

    expect(connections.holderOf({ userId: 'ada', cohortId: 'frontend' })).toBe(
      frontend,
    );
    expect(connections.holderOf({ userId: 'ada', cohortId: 'backend' })).toBe(
      backend,
    );

    connections.remove(frontend);
    expect(
      connections.holderOf({ userId: 'ada', cohortId: 'frontend' }),
    ).toBeUndefined();
    expect(connections.holderOf({ userId: 'ada', cohortId: 'backend' })).toBe(
      backend,
    );
  });

  it('keeps two accounts’ seats in one cohort apart', () => {
    const connections = new Connections();
    const ada = connection('ada', 'frontend');
    const grace = connection('grace', 'frontend');
    connections.add(ada);
    connections.add(grace);

    expect(connections.holderOf({ userId: 'ada', cohortId: 'frontend' })).toBe(
      ada,
    );
    expect(
      connections.holderOf({ userId: 'grace', cohortId: 'frontend' }),
    ).toBe(grace);

    connections.remove(ada);
    expect(
      connections.holderOf({ userId: 'ada', cohortId: 'frontend' }),
    ).toBeUndefined();
    expect(
      connections.holderOf({ userId: 'grace', cohortId: 'frontend' }),
    ).toBe(grace);
  });

  it('does not mix the account and the cohort up', () => {
    const connections = new Connections();
    const held = connection('frontend', 'ada');
    connections.add(held);

    expect(
      connections.holderOf({ userId: 'ada', cohortId: 'frontend' }),
    ).toBeUndefined();
    expect(connections.holderOf({ userId: 'frontend', cohortId: 'ada' })).toBe(
      held,
    );
  });

  it('answers "is this the holder" apart from "who holds it"', () => {
    const connections = new Connections();
    const first = connection('ada', 'frontend');
    const second = connection('ada', 'frontend');
    connections.add(first);

    expect(connections.add(second)).toBe(first);
    expect(connections.has(first)).toBe(false);
    expect(connections.has(second)).toBe(true);
    // A replaced connection still names the seat, and the seat's holder is
    // the newer one: what the gateway asks before it takes an avatar away.
    expect(connections.holderOf(first)).toBe(second);
  });
});
