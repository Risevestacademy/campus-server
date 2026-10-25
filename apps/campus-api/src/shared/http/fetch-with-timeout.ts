const FETCH_TIMEOUT_MS = 10_000;

/** fetch, giving up: a request that hangs must not hang the caller's. */
export const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
