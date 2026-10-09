import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // As in campus-api: resolve the shared package from source so a test run
  // does not depend on whether it has been built yet.
  resolve: {
    alias: {
      '@campus/media': fileURLToPath(
        new URL('../../packages/media/src/index.ts', import.meta.url),
      ),
      '@campus/session': fileURLToPath(
        new URL('../../packages/session/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    root: './',
    include: ['src/**/*.spec.ts'],
    // Sockets bind real ports and the expiry case waits on a heartbeat.
    testTimeout: 20_000,
  },
});
