import type { NotificationCreated } from '@campus/session';
import { describe, expect, it } from 'vitest';

import {
  COHORT,
  arrive,
  leave,
  notifications,
  person,
  quiet,
  useWorld,
  waitFor,
  world,
} from './gateway.testing.js';

useWorld();

const OTHER_COHORT = 'cohort-2';

/** A message on the channel, as campus-api publishes one for a notice. */
const posted = (
  recipientId: string,
  cohortId: string | null,
): NotificationCreated => ({
  recipientId,
  cohortId,
  id: `notification-for-${recipientId}`,
  kind: 'notice_posted',
  referenceType: 'notice',
  referenceId: 'notice-1',
  createdAt: '2026-11-05T09:30:00.000Z',
});

const pushedTo = (conn: { messages: Record<string, unknown>[] }) =>
  conn.messages.filter((m) => m.type === 'notification');

describe('notifications', () => {
  it('pushes one about no cohort to every socket the recipient has open', async () => {
    const ada = person();
    const here = await arrive(ada);
    const there = await arrive(ada, OTHER_COHORT);

    notifications.deliver(posted(ada, null));

    const expected = {
      type: 'notification',
      id: `notification-for-${ada}`,
      kind: 'notice_posted',
      referenceType: 'notice',
      referenceId: 'notice-1',
      createdAt: '2026-11-05T09:30:00.000Z',
    };
    await expect(
      waitFor(here, (m) => m.type === 'notification'),
    ).resolves.toEqual(expected);
    await expect(
      waitFor(there, (m) => m.type === 'notification'),
    ).resolves.toEqual(expected);
    await Promise.all([leave(here), leave(there)]);
  });

  it("pushes one about a cohort only on that cohort's socket", async () => {
    const ada = person();
    const here = await arrive(ada);
    const there = await arrive(ada, OTHER_COHORT);

    notifications.deliver(posted(ada, OTHER_COHORT));

    await waitFor(there, (m) => m.type === 'notification');
    await quiet();
    expect(pushedTo(there)).toHaveLength(1);
    expect(pushedTo(here)).toEqual([]);
    await Promise.all([leave(here), leave(there)]);
  });

  it('pushes nothing to anybody else, and nothing when the recipient is not here', async () => {
    const ada = person();
    const grace = person();
    const here = await arrive(ada);

    notifications.deliver(posted(grace, null));
    notifications.deliver(posted(grace, COHORT));
    await quiet();

    expect(pushedTo(here)).toEqual([]);
    expect(world.gateway.connections.size).toBe(1);
    await leave(here);
  });

  it('pushes nothing for a cohort the recipient has no socket in', async () => {
    const ada = person();
    const here = await arrive(ada);

    notifications.deliver(posted(ada, OTHER_COHORT));
    await quiet();

    expect(pushedTo(here)).toEqual([]);
    await leave(here);
  });
});
