import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // As in campus-api and world: resolve the shared package from source so a
  // test run does not depend on whether @campus/session has been built yet.
  resolve: {
    alias: {
      '@campus/session': fileURLToPath(
        new URL('../session/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
