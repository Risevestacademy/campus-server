import { DEFAULT_SPACE_KEY } from '@campus/session';
import { SPACE_ACCESS } from '@campus/space-access';
import { describe, expect, it } from 'vitest';

import type { WorldSpace } from '../infra/accounts.js';
import { SpaceLocks, isLockable, lockableKeys } from './locks.js';

const meetingRoom: WorldSpace = {
  id: 'space-1',
  kind: 'meeting_room',
  access: SPACE_ACCESS.Normal,
  retiredAt: null,
  locked: false,
  grants: [],
  audioMode: 'boundary',
  audibleRadius: 5,
  subscribeRadius: 6,
  hysteresisFactor: 1.2,
};

describe('isLockable', () => {
  it('lets a normal whole-room space be locked, the town hall included', () => {
    expect(isLockable('room', meetingRoom)).toBe(true);
    expect(isLockable('hall', { ...meetingRoom, kind: 'town_hall' })).toBe(
      true,
    );
  });

  it.each<[string, Partial<WorldSpace>]>([
    ['a proximity space', { audioMode: 'proximity' }],
    ['the notice board, whatever it hears by', { kind: 'notice_board' }],
    ['a designated space', { access: SPACE_ACCESS.Designated }],
    ['a space not set up yet', { kind: null }],
    ['a retired space', { retiredAt: new Date() }],
  ])('never %s', (_, change) => {
    expect(isLockable('room', { ...meetingRoom, ...change })).toBe(false);
  });

  it('never the corridors', () => {
    expect(isLockable(DEFAULT_SPACE_KEY, meetingRoom)).toBe(false);
  });

  it('lists the lockable ones by key, sorted', () => {
    expect(
      lockableKeys(
        new Map([
          ['studio', meetingRoom],
          ['lounge', { ...meetingRoom, audioMode: 'proximity' }],
          ['annex', meetingRoom],
        ]),
      ),
    ).toEqual(['annex', 'studio']);
  });
});

describe('SpaceLocks', () => {
  it('keeps each cohort’s locks apart', () => {
    const locks = new SpaceLocks();

    expect(locks.lock('cohort-1', 'library')).toBe(true);

    expect(locks.isLocked('cohort-1', 'library')).toBe(true);
    expect(locks.isLocked('cohort-2', 'library')).toBe(false);
    expect(locks.in('cohort-2')).toEqual([]);
  });

  it('says whether locking or unlocking changed anything', () => {
    const locks = new SpaceLocks();

    expect(locks.lock('cohort-1', 'library')).toBe(true);
    expect(locks.lock('cohort-1', 'library')).toBe(false);
    expect(locks.unlock('cohort-1', 'library')).toBe(true);
    expect(locks.unlock('cohort-1', 'library')).toBe(false);
    expect(locks.all()).toEqual([]);
  });

  it('lists every lock, and a cohort’s sorted', () => {
    const locks = new SpaceLocks();
    locks.lock('cohort-1', 'studio');
    locks.lock('cohort-1', 'annex');
    locks.lock('cohort-2', 'studio');

    expect(locks.in('cohort-1')).toEqual(['annex', 'studio']);
    expect(locks.all()).toEqual(
      expect.arrayContaining([
        { cohortId: 'cohort-1', spaceKey: 'annex' },
        { cohortId: 'cohort-1', spaceKey: 'studio' },
        { cohortId: 'cohort-2', spaceKey: 'studio' },
      ]),
    );
  });
});
