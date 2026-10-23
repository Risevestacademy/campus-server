import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { bootstrap } from './bootstrap.js';
import { loadEnv } from './infra/config/env.js';
import { ERROR_REPORTER } from './infra/error-reporting/error-reporting.module.js';

vi.mock('./app.module.js', () => ({ AppModule: class AppModule {} }));
vi.mock('@nestjs/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nestjs/core')>()),
  NestFactory: { create: vi.fn() },
}));
vi.mock('@nestjs/swagger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nestjs/swagger')>();
  return {
    ...original,
    SwaggerModule: { ...original.SwaggerModule, createDocument: () => ({}) },
  };
});

const config = loadEnv();

/** Records, in order, what happens on the way out. */
function harness() {
  const steps: string[] = [];
  const telemetry = {
    shutdown: vi.fn(async () => {
      steps.push('telemetry flushed');
    }),
  };
  const reporter = {
    report: vi.fn(),
    shutdown: vi.fn(async () => {
      steps.push('reporter flushed');
    }),
  };
  const logger = { error: vi.fn() };
  const exitProcess = vi.fn((code: number) => {
    steps.push(`exit ${code}`);
  });
  return { steps, telemetry, reporter, logger, exitProcess };
}

/** Enough of a Nest app for bootstrap to configure it, until listen fails. */
function appThatCannotListen(logger: object, reporter: object, failure: Error) {
  return {
    useBodyParser: vi.fn(),
    get: vi.fn((token: unknown) =>
      token === Logger
        ? logger
        : token === ERROR_REPORTER
          ? reporter
          : undefined,
    ),
    useLogger: vi.fn(),
    set: vi.fn(),
    enableCors: vi.fn(),
    setGlobalPrefix: vi.fn(),
    useGlobalPipes: vi.fn(),
    useGlobalFilters: vi.fn(),
    use: vi.fn(),
    getHttpAdapter: () => ({ get: vi.fn() }),
    listen: vi.fn(async () => {
      throw failure;
    }),
    close: vi.fn(async () => undefined),
  };
}

describe('bootstrap, when the API fails to start', () => {
  const listeners = process.listeners('SIGTERM');

  afterEach(() => {
    for (const listener of process.listeners('SIGTERM')) {
      if (!listeners.includes(listener)) {
        process.off('SIGTERM', listener);
      }
    }
  });

  it('flushes telemetry, then exits 1, when the Nest app cannot be built', async () => {
    const { steps, telemetry, exitProcess } = harness();
    const failure = new Error('a provider threw in onModuleInit');
    vi.mocked(NestFactory.create).mockRejectedValueOnce(failure);
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await bootstrap(config, telemetry, exitProcess);

    expect(consoleError).toHaveBeenCalledWith('Failed to start', failure);
    expect(steps).toEqual(['telemetry flushed', 'exit 1']);
    consoleError.mockRestore();
  });

  it('reports the failure, flushes telemetry and PostHog, then exits 1, when it cannot listen', async () => {
    const { steps, telemetry, reporter, logger, exitProcess } = harness();
    const failure = Object.assign(new Error('listen EADDRINUSE'), {
      code: 'EADDRINUSE',
    });
    vi.mocked(NestFactory.create).mockResolvedValueOnce(
      appThatCannotListen(logger, reporter, failure) as never,
    );

    await bootstrap(config, telemetry, exitProcess);

    expect(logger.error).toHaveBeenCalledWith(
      { err: failure },
      'Failed to start',
      'bootstrap',
    );
    expect(steps).toEqual(
      expect.arrayContaining(['telemetry flushed', 'reporter flushed']),
    );
    expect(steps.at(-1)).toBe('exit 1');
  });
});
