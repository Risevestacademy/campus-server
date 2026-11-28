import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // As in campus-api and world: resolve the shared package from source so a
  // test run does not depend on whether @campus/contracts has been built yet.
  resolve: {
    alias: {
      '@campus/contracts': fileURLToPath(
        new URL('../contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
