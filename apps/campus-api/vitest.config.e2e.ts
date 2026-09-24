import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
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
    },
  },
});
