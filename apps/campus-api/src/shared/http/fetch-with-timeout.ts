export const FETCH_TIMEOUT_MS = 10_000;

/**
 * fetch that gives up after `ms` in all: one attempt, no retries, so a
 * request that hangs cannot hang the caller's for longer.
 */
export function timedFetch(ms: number): typeof fetch {
  return (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
}

export const fetchWithTimeout = timedFetch(FETCH_TIMEOUT_MS);
