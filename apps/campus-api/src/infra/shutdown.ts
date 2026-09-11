export interface ShutdownTarget {
  close(): Promise<unknown>;
}

const DEFAULT_APP_CLOSE_TIMEOUT_MS = 5000;

function closeWithTimeout(app: ShutdownTarget, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`app.close() did not finish within ${timeoutMs}ms, continuing shutdown anyway`);
      resolve();
    }, timeoutMs);
    app
      .close()
      .catch((error) => console.error('Error closing app', error))
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

export async function gracefulShutdown(
  app: ShutdownTarget | undefined,
  resources: Array<() => Promise<unknown>>,
  appCloseTimeoutMs = DEFAULT_APP_CLOSE_TIMEOUT_MS,
): Promise<void> {
  if (app) {
    await closeWithTimeout(app, appCloseTimeoutMs);
  }
  const results = await Promise.allSettled(resources.map((shutdown) => shutdown()));
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Error during shutdown', result.reason);
    }
  }
}
