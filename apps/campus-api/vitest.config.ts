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
  },
});
