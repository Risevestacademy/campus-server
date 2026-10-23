import { describe, expect, it, vi } from 'vitest';

import { flushAll } from './exit.js';

describe('flushAll', () => {
  it('flushes the reporter and telemetry together', async () => {
    const reporter = { shutdown: vi.fn(async () => undefined) };
    const telemetry = { shutdown: vi.fn(async () => undefined) };
    const log = { warn: vi.fn() };

    await flushAll(log, [reporter, telemetry]);

    expect(reporter.shutdown).toHaveBeenCalledTimes(1);
    expect(telemetry.shutdown).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns about a flush that fails, still runs the others, and never throws', async () => {
    const failure = new Error('PostHog unreachable');
    const reporter = { shutdown: vi.fn(async () => Promise.reject(failure)) };
    const telemetry = { shutdown: vi.fn(async () => undefined) };
    const log = { warn: vi.fn() };

    await expect(flushAll(log, [reporter, telemetry])).resolves.toBeUndefined();

    expect(telemetry.shutdown).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { err: failure },
      'could not flush on exit',
    );
  });

  it('skips what is not there, such as telemetry switched off', async () => {
    const reporter = { shutdown: vi.fn(async () => undefined) };

    await flushAll({ warn: vi.fn() }, [reporter, undefined]);

    expect(reporter.shutdown).toHaveBeenCalledTimes(1);
  });
});
