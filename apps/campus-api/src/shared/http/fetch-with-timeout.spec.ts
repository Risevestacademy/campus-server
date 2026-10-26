import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  timedFetch,
} from './fetch-with-timeout.js';

describe('timedFetch', () => {
  let server: Server;
  let url: string;
  let received = 0;

  beforeAll(async () => {
    // Takes every request and never answers.
    server = createServer(() => {
      received += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    received = 0;
  });

  it('gives up on a request that hangs, once, with no retry', async () => {
    const started = Date.now();

    await expect(timedFetch(200)(url, { method: 'POST' })).rejects.toThrow();

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    expect(received).toBe(1);
  });

  it('stops sooner when the caller’s own deadline passes first', async () => {
    const started = Date.now();

    await expect(
      timedFetch(5_000)(url, { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(received).toBe(1);
  });

  it('gives Google ten seconds in all', () => {
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
    expect(fetchWithTimeout).toBeTypeOf('function');
  });
});
