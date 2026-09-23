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
    // committed migrations in beforeAll (~10s each alone, slower when
    // several run in parallel). The default 10s hookTimeout flakes under
    // that load, so it is raised — it only bounds hooks, not tests.
    hookTimeout: 60_000,
    // app.controller.spec boots the full AppModule, whose validated Env
    // requires APP_PUBLIC_URL — provided here so unit tests stay hermetic.
    env: {
      APP_PUBLIC_URL: 'http://localhost:3000',
    },
  },
});
