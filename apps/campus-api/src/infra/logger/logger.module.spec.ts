import { captureLines } from '@campus/error-reporting/testing';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import { pinoHttp } from 'pino-http';

import type { Env } from '../config/config.module.js';
import {
  isUnloggedRoute,
  pinoHttpOptions,
  routeOnceFinished,
  serializeRequest,
} from './logger.module.js';

describe('isUnloggedRoute', () => {
  it('drops uptime probes and the API reference', () => {
    expect(isUnloggedRoute('/v1/health')).toBe(true);
    expect(isUnloggedRoute('/docs')).toBe(true);
    expect(isUnloggedRoute('/docs-json')).toBe(true);
  });

  it('matches on the path, so query strings do not slip through', () => {
    expect(isUnloggedRoute('/v1/health?verbose=1')).toBe(true);
    expect(isUnloggedRoute('/docs?theme=dark')).toBe(true);
  });

  it('drops the assets the reference loads beneath itself', () => {
    expect(isUnloggedRoute('/docs/assets/app.js')).toBe(true);
  });

  it('keeps everything else, including lookalikes', () => {
    expect(isUnloggedRoute('/v1/invites')).toBe(false);
    expect(isUnloggedRoute('/v1/health-check')).toBe(false);
    expect(isUnloggedRoute('/docsomething')).toBe(false);
    expect(isUnloggedRoute('/health')).toBe(false);
    expect(isUnloggedRoute(undefined)).toBe(false);
  });
});

describe('serializeRequest', () => {
  it('logs the path and never the query string', () => {
    expect(
      serializeRequest({
        id: 'corr-1',
        method: 'GET',
        url: '/v1/auth/google/callback?code=4/0Aabc&state=xyz',
        remoteAddress: '10.0.0.1',
        remotePort: 4321,
      }),
    ).toEqual({
      id: 'corr-1',
      method: 'GET',
      url: '/v1/auth/google/callback',
      remoteAddress: '10.0.0.1',
      remotePort: 4321,
    });
  });
});

describe('routeOnceFinished', () => {
  const req = { route: { path: '/v1/invites/:id/revoke' } };

  it('names the route once the response is done', () => {
    expect(routeOnceFinished(req, { writableEnded: true })).toEqual({
      route: '/v1/invites/:id/revoke',
    });
  });

  it('adds nothing before then, when the route is not known yet', () => {
    expect(routeOnceFinished(req, { writableEnded: false })).toEqual({});
    expect(routeOnceFinished({}, { writableEnded: true })).toEqual({
      route: undefined,
    });
  });
});

describe('pinoHttpOptions', () => {
  const options = () =>
    pinoHttpOptions({ FF_LOG_LEVEL: 'info', FF_LOG_PRETTY: false } as Env, {
      report: vi.fn(),
      shutdown: vi.fn(),
    });
  const query = 'insert into "users" ("email") values ($1)';
  const rejected = Object.assign(
    new Error('duplicate key value violates unique constraint "users_email"'),
    {
      name: 'PostgresError',
      code: '23505',
      severity: 'ERROR',
      detail: 'Key (email)=(ada@example.com) already exists.',
    },
  );
  const failed = Object.assign(
    new Error(`Failed query: ${query}\nparams: ada@example.com`, {
      cause: rejected,
    }),
    { query, params: ['ada@example.com'] },
  );

  // pino-http wraps the `err` serializer around its own.
  it('logs a failed query without the values it was given, through pino-http', () => {
    const { stream, lines } = captureLines();

    const { logger } = pinoHttp(options(), stream);
    logger.error({ err: failed }, 'Unhandled exception');
    logger.error(failed);
    logger.warn({ err: rejected }, 'retrying');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('SQLSTATE 23505');
    expect(lines.join('')).not.toContain('ada@example.com');
  });

  // nestjs-pino hands an error logged on its own to pino as `{ err }`.
  it("logs a failed query without its values through nestjs-pino's Logger", async () => {
    const { stream, lines } = captureLines();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [options(), stream] })],
    }).compile();
    const logger = moduleRef.get(Logger);

    logger.error(failed);
    logger.error(
      { err: failed },
      'Unhandled exception',
      'GlobalExceptionFilter',
    );
    await moduleRef.close();

    expect(lines).toHaveLength(2);
    expect(lines.join('')).toContain('SQLSTATE 23505');
    expect(lines.join('')).not.toContain('ada@example.com');
  });
});
