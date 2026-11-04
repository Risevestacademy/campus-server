import {} from '@campus/session';
import {} from '@campus/space-access';
import { describe, expect, it } from 'vitest';

import { oneAtATime } from './one-at-a-time.js';
import {} from '../infra/presence.js';

import { deferred, useWorld } from './gateway.testing.js';

useWorld();

describe('oneAtATime', () => {
  it('does not start a task again while the last run is still going', async () => {
    const runs: ReturnType<typeof deferred<void>>[] = [];
    const run = oneAtATime(
      () => {
        const next = deferred<void>();
        runs.push(next);
        return next.promise;
      },
      () => undefined,
    );

    run();
    run();
    run();
    expect(runs).toHaveLength(1);

    runs[0]!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    run();
    expect(runs).toHaveLength(2);
  });

  /** An unhandled rejection would take the process down. */
  it('hands a failure to onError and runs again afterwards', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const run = oneAtATime(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('database unavailable');
      },
      (err) => errors.push(err),
    );

    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
