import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

const MAP_SYNC_PG_SPEC = 'src/modules/maps/map-sync.service.pg.spec.ts';

export default defineConfig({
  // Workspace packages ship built output, so importing one by name means
  // tests only run after a build. Pointing at the source keeps a test run
  // independent of build order — the built entry is what production uses,
  // and the boot smoke test in CI exercises that.
  resolve: {
    alias: {
      '@campus/telemetry/sql': fileURLToPath(
        new URL('../../packages/telemetry/src/sql.ts', import.meta.url),
      ),
      '@campus/telemetry/paths': fileURLToPath(
        new URL('../../packages/telemetry/src/paths.ts', import.meta.url),
      ),
      '@campus/analytics/testing': fileURLToPath(
        new URL('../../packages/analytics/src/testing.ts', import.meta.url),
      ),
      '@campus/analytics': fileURLToPath(
        new URL('../../packages/analytics/src/index.ts', import.meta.url),
      ),
      '@campus/error-reporting/testing': fileURLToPath(
        new URL(
          '../../packages/error-reporting/src/testing.ts',
          import.meta.url,
        ),
      ),
      '@campus/error-reporting': fileURLToPath(
        new URL('../../packages/error-reporting/src/index.ts', import.meta.url),
      ),
      '@campus/session': fileURLToPath(
        new URL('../../packages/session/src/index.ts', import.meta.url),
      ),
      '@campus/media/testing': fileURLToPath(
        new URL('../../packages/media/src/testing.ts', import.meta.url),
      ),
      '@campus/media': fileURLToPath(
        new URL('../../packages/media/src/index.ts', import.meta.url),
      ),
      '@campus/space-access': fileURLToPath(
        new URL('../../packages/space-access/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    root: './',
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
    // The real-PostgreSQL files share one database, and keep to their own
    // rows so they can run side by side. The map sync's test cannot: it
    // retires every map, so it runs on its own once the rest have finished.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['**/*.spec.ts'],
          exclude: [...configDefaults.exclude, MAP_SYNC_PG_SPEC],
          // Applies the migrations to the real PostgreSQL a few tests need,
          // when one is named; does nothing otherwise.
          globalSetup: ['./vitest.global-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'map-sync-pg',
          include: [MAP_SYNC_PG_SPEC],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
