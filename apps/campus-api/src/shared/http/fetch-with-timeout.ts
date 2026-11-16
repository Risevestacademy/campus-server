export const FETCH_TIMEOUT_MS = 10_000;

/**
 * fetch that gives up after `ms` in all: one attempt, no retries, so a
 * request that hangs cannot hang the caller's for longer. A signal the caller
 * passes still applies: a deadline across several requests ends this one too.
 */
export function timedFetch(ms: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    return fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
}

export const fetchWithTimeout = timedFetch(FETCH_TIMEOUT_MS);
