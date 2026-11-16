import { SessionScope, type NotificationCreated } from '@campus/session';
import { describe, expect, it } from 'vitest';

import {
  COHORT,
  ORIGIN,
  SECRET,
  arrive,
  connect,
  leave,
  notifications,
  person,
  quiet,
  token,
  url,
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
  context: null,
  createdAt: '2026-11-05T09:30:00.000Z',
});

/** The account's second socket in a cohort it already stands in: a watcher. */
async function watch(userId: string, cohortId = COHORT) {
  const query = new URLSearchParams({ cohortId, enter: 'ifFree' });
  const conn = connect(
    {
      origin: ORIGIN,
      cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
    },
    '',
    `${url}?${query.toString()}`,
  );
  const welcome = await waitFor(conn, (m) => m.type === 'welcome');
  expect(welcome.mode).toBe('watcher');
  await waitFor(conn, (m) => m.type === 'snapshot');
  return conn;
}

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
      context: null,
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

  it("pushes one about a cohort to that cohort's watchers too", async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await watch(ada);

    notifications.deliver(posted(ada, COHORT));

    await waitFor(web, (m) => m.type === 'notification');
    await waitFor(phone, (m) => m.type === 'notification');
    await quiet();
    expect(pushedTo(web)).toHaveLength(1);
    expect(pushedTo(phone)).toHaveLength(1);
    await Promise.all([leave(web), leave(phone)]);
  });

  it('pushes one about no cohort to every watcher the recipient has', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await watch(ada);

    notifications.deliver(posted(ada, null));

    await waitFor(phone, (m) => m.type === 'notification');
    await quiet();
    expect(pushedTo(web)).toHaveLength(1);
    expect(pushedTo(phone)).toHaveLength(1);
    await Promise.all([leave(web), leave(phone)]);
  });
});
