import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workspace packages ship built output, so importing one by name means
  // tests only run after a build. Pointing at the source keeps a test run
  // independent of build order — the built entry is what production uses,
  // and the boot smoke test in CI exercises that.
  resolve: {
    alias: {
      '@campus/session': fileURLToPath(
        new URL('../../packages/session/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    hookTimeout: 60_000,
    testTimeout: 20_000,
    // AppModule validates the environment as it is imported, so anything a
    // route needs has to be present before the first import runs. These are
    // dummies: the e2e suite never reaches Google.
    env: {
      APP_PUBLIC_URL: 'http://localhost:3000',
      FF_GOOGLE_AUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
      AUTH_STATE_SECRET: 'an-e2e-state-secret-of-at-least-32-chars',
      AUTH_SESSION_SECRET: 'an-e2e-session-secret-of-at-least-32-chars',
      CORS_ORIGINS: 'http://localhost:3000',
    },
  },
});
