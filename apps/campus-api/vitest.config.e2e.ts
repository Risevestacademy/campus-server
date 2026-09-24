import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Required Env fields (e.g. APP_PUBLIC_URL) must resolve when specs boot
    // the full AppModule; test-only values live here, not in committed .env.
    env: {
      APP_PUBLIC_URL: 'http://localhost:3000',
    },
  },
});
