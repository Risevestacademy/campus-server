import { SessionScope } from '@campus/session';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { buildWorld } from '../app.js';
import { MemoryPresenceStore } from '../infra/presence.js';

import {
  COHORT,
  ORIGIN,
  SECRET,
  accounts,
  arrive,
  connect,
  env,
  leave,
  map,
  person,
  presence,
  presenceKeyOf,
  quiet,
  step,
  store,
  token,
  url,
  useWorld,
  waitFor,
  world,
} from './gateway.testing.js';

useWorld();

type Conn = ReturnType<typeof connect>;

/** The phone's way in: the avatar only if nobody holds it. */
async function ifFree(
  userId: string,
  {
    resume,
    cohortId = COHORT,
    at = url,
  }: { resume?: string; cohortId?: string; at?: string } = {},
) {
  const query = new URLSearchParams({ cohortId, enter: 'ifFree' });
  if (resume) query.set('resume', resume);
  const conn = connect(
    {
      origin: ORIGIN,
      cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, userId)}`,
    },
    '',
    `${at}?${query.toString()}`,
  );
  await waitFor(conn, (m) => m.type === 'snapshot');
  return conn;
}

const welcomeOf = (conn: Conn) => waitFor(conn, (m) => m.type === 'welcome');
const modeOf = async (conn: Conn) => (await welcomeOf(conn)).mode;
const typesIn = (conn: Conn) => conn.messages.map((m) => m.type);
const send = (conn: Conn, message: Record<string, unknown>) =>
  conn.ws.send(JSON.stringify(message));

describe('entering only if free', () => {
  it('stands for the account when it holds nothing in the cohort', async () => {
    const ada = person();
    const phone = await ifFree(ada);

    expect(await modeOf(phone)).toBe('avatar');
    const snapshot = await waitFor(phone, (m) => m.type === 'snapshot');
    expect(snapshot.players).toContainEqual(
      expect.objectContaining({ userId: ada }),
    );
    await leave(phone);
  });

  it('watches, and leaves the avatar where it is, when the account stands in the cohort', async () => {
    const ada = person();
    const web = await arrive(ada);
    const webId = (await welcomeOf(web)).connectionId;
    const other = await arrive(person());

    const phone = await ifFree(ada);

    expect(await modeOf(phone)).toBe('watcher');
    const snapshot = await waitFor(phone, (m) => m.type === 'snapshot');
    expect(snapshot.players).toContainEqual(
      expect.objectContaining({ userId: ada }),
    );
    await quiet();
    expect(typesIn(web)).not.toContain('replaced');
    expect(typesIn(other)).not.toContain('joined');
    expect(presence.entries.get(presenceKeyOf({ userId: ada }))).toMatchObject({
      connectionId: webId,
    });
    expect(world.gateway.connections.watcherCount).toBe(1);
    await leave(phone);
    await leave(web);
    await leave(other);
  });

  it('watches in one cohort and stands in another, each decided on its own', async () => {
    const ada = person();
    const web = await arrive(ada, 'cohort-frontend');

    const watching = await ifFree(ada, { cohortId: 'cohort-frontend' });
    const standing = await ifFree(ada, { cohortId: 'cohort-backend' });

    expect(await modeOf(watching)).toBe('watcher');
    expect(await modeOf(standing)).toBe('avatar');
    await leave(watching);
    await leave(standing);
    await leave(web);
  });

  it('lets several watch at once', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await ifFree(ada);
    const tablet = await ifFree(ada);

    send(web, { type: 'setStatus', status: 'busy' });

    for (const conn of [phone, tablet]) {
      await expect(
        waitFor(conn, (m) => m.type === 'statusChanged'),
      ).resolves.toMatchObject({ userId: ada, status: 'busy' });
    }
    await leave(phone);
    await leave(tablet);
    await leave(web);
  });

  it('watches when the avatar is held for a reconnect by another connection', async () => {
    const ada = person();
    const web = await arrive(ada);
    await leave(web);

    const phone = await ifFree(ada, { resume: 'some-other-connection' });

    expect(await modeOf(phone)).toBe('watcher');
    await leave(phone);
  });

  it('resumes its own avatar within the grace, given its last connection', async () => {
    const ada = person();
    const first = await ifFree(ada);
    const firstId = (await welcomeOf(first)).connectionId as string;
    await step(first, 'right', 1);
    await leave(first);

    const again = await ifFree(ada, { resume: firstId });

    expect(await modeOf(again)).toBe('avatar');
    const snapshot = await waitFor(again, (m) => m.type === 'snapshot');
    expect(snapshot.players).toContainEqual(
      expect.objectContaining({ userId: ada, x: 1 }),
    );
    await leave(again);
  });

  it('watches when another instance holds the avatar', async () => {
    const ada = person();
    presence.onOtherInstances.push({
      userId: ada,
      connectionId: 'elsewhere',
      cohortId: COHORT,
      spaceKey: '_default',
      since: Date.now(),
      status: 'available',
      instanceId: 'another-instance',
    });
    try {
      const phone = await ifFree(ada);

      expect(await modeOf(phone)).toBe('watcher');
      await leave(phone);
    } finally {
      presence.onOtherInstances.length = 0;
    }
  });

  it('takes the avatar as before without asking, displacing a watcher nobody', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await ifFree(ada);

    const laptop = await arrive(ada);

    await expect(web.settled).resolves.toMatchObject({
      closeCode: 4000,
      closeReason: 'entered_elsewhere',
    });
    await quiet();
    expect(typesIn(phone)).not.toContain('watching');
    expect(phone.ws.readyState).toBe(phone.ws.OPEN);
    await leave(phone);
    await leave(laptop);
  });
});

describe('demoted to watching', () => {
  it('keeps a displaced ifFree socket open as a watcher', async () => {
    const ada = person();
    const phone = await ifFree(ada);
    const watcher = await arrive(person());

    const web = await arrive(ada);

    await waitFor(phone, (m) => m.type === 'watching');
    expect(typesIn(phone)).not.toContain('replaced');
    expect(phone.ws.readyState).toBe(phone.ws.OPEN);
    await quiet();
    expect(typesIn(watcher)).not.toContain('left');

    send(web, { type: 'setStatus', status: 'busy' });
    await expect(
      waitFor(phone, (m) => m.type === 'statusChanged'),
    ).resolves.toMatchObject({ userId: ada, status: 'busy' });
    send(phone, { type: 'move', direction: 'right', seq: 1 });
    await expect(
      waitFor(phone, (m) => m.type === 'error'),
    ).resolves.toMatchObject({ code: 'NOT_ALLOWED' });
    await leave(phone);
    await leave(web);
    await leave(watcher);
  });

  it('hands the replacing socket the status chosen on the phone', async () => {
    const ada = person();
    const phone = await ifFree(ada);
    send(phone, { type: 'setStatus', status: 'busy' });
    await waitFor(phone, (m) => m.type === 'statusChanged');

    const web = await arrive(ada);

    const snapshot = await waitFor(web, (m) => m.type === 'snapshot');
    expect(snapshot.players).toContainEqual(
      expect.objectContaining({ userId: ada, status: 'busy' }),
    );
    await leave(phone);
    await leave(web);
  });
});

describe('what a watcher sees and does', () => {
  it('sees arrivals, departures and changes of space, but no moves', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await ifFree(ada);

    const grace = await arrive(person());
    for (const seq of [1, 2, 3]) await step(web, 'right', seq);
    await leave(grace);

    await waitFor(phone, (m) => m.type === 'left');
    expect(typesIn(phone)).toContain('joined');
    expect(typesIn(phone)).toContain('spaceChanged');
    await quiet();
    expect(typesIn(phone)).not.toContain('moved');
    expect(typesIn(phone)).not.toContain('moveResult');
    await leave(phone);
    await leave(web);
  });

  it('sets the status of the avatar it watches, for the whole cohort', async () => {
    const ada = person();
    const web = await arrive(ada);
    const other = await arrive(person());
    const phone = await ifFree(ada);

    send(phone, { type: 'setStatus', status: 'busy', forSeconds: 300 });

    for (const conn of [web, other, phone]) {
      await expect(
        waitFor(conn, (m) => m.type === 'statusChanged'),
      ).resolves.toMatchObject({
        userId: ada,
        status: 'busy',
        until: expect.any(String),
      });
    }
    await expect
      .poll(() => presence.entries.get(presenceKeyOf({ userId: ada }))?.status)
      .toBe('busy');
    await leave(phone);
    await leave(web);
    await leave(other);
  });

  it('is told it is not on campus when nobody stands for it', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await ifFree(ada);
    await leave(web);
    await waitFor(phone, (m) => m.type === 'left' && m.userId === ada);

    send(phone, { type: 'setStatus', status: 'busy' });

    await expect(
      waitFor(phone, (m) => m.type === 'error'),
    ).resolves.toMatchObject({ code: 'NOT_ALLOWED' });
    await leave(phone);
  });

  it('takes nothing a watcher sends as activity, and answers a ping', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await ifFree(ada);

    send(phone, { type: 'active' });
    send(phone, { type: 'ping' });

    await waitFor(phone, (m) => m.type === 'pong');
    expect(typesIn(phone)).not.toContain('error');
    await leave(phone);
    await leave(web);
  });

  it('is closed with the account when it is suspended', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await ifFree(ada);

    accounts.suspended.add(ada);

    await expect(phone.settled).resolves.toMatchObject({
      closeReason: 'account_suspended',
    });
    await web.settled;
  });

  it('is closed when its own session ends, and the avatar stays', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await ifFree(ada);
    accounts.epochs.set(ada, 1);

    await expect(phone.settled).resolves.toMatchObject({
      closeReason: 'session_revoked',
    });
    await web.settled;
  });

  it('is closed when the membership ends, and so is the avatar', async () => {
    const ada = person();
    const web = await arrive(ada);
    const phone = await ifFree(ada);

    accounts.notMembers.add(`${ada}:${COHORT}`);

    await expect(phone.settled).resolves.toMatchObject({
      closeReason: 'not_a_member',
    });
    await expect(web.settled).resolves.toMatchObject({
      closeReason: 'not_a_member',
    });
  });

  it('is closed with everybody when world shuts down', async () => {
    const own = await buildWorld({
      env,
      accounts,
      positions: store,
      presence: new MemoryPresenceStore(),
      map,
    });
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    const ownUrl = `ws://127.0.0.1:${(own.app.server.address() as AddressInfo).port}/socket`;
    const ada = person();
    const web = connect(
      {
        origin: ORIGIN,
        cookie: `campus_session=${await token(SessionScope.FullAccess, SECRET, ada)}`,
      },
      COHORT,
      ownUrl,
    );
    await waitFor(web, (m) => m.type === 'snapshot');
    const phone = await ifFree(ada, { at: ownUrl });
    expect(await modeOf(phone)).toBe('watcher');

    try {
      await own.gateway.stop();

      for (const conn of [web, phone]) {
        await expect(conn.settled).resolves.toMatchObject({
          closeCode: 1001,
          closeReason: 'server shutting down',
        });
      }
    } finally {
      own.gateway.dispose();
      await own.app.close();
    }
  });
});
