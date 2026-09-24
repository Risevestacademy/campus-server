import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // class-transformer's @Type() (used in infra/config/env.ts) needs the
    // reflect-metadata polyfill loaded before any decorated class is
    // evaluated. main.ts guarantees this via its first import; tests need
    // the same guarantee when they import a decorated class directly.
    setupFiles: ['reflect-metadata'],
    // PGlite suites boot a full Postgres engine in WASM and apply the
    // committed migrations in beforeAll. Running in parallel that takes
    // longer than the 10s default, and a hook that times out reports as the
    // whole file being skipped rather than as anything to do with timing.
    hookTimeout: 60_000,
    testTimeout: 20_000,
    // app.controller.spec boots the full AppModule, whose validated Env
    // requires APP_PUBLIC_URL — provided here so unit tests stay hermetic.
    env: {
      APP_PUBLIC_URL: 'http://localhost:3000',
    },
  },
});
