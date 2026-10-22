import { Controller, Get, INestApplication, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module.js';
import {
  ERROR_REPORTER,
  type ErrorReporter,
} from './../src/infra/error-reporting/error-reporting.module.js';
import { DomainException } from './../src/shared/exceptions/domain.exception.js';
import { ExceptionCode } from './../src/shared/exceptions/exception-code.enum.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
} from './../src/shared/filters/index.js';

class UnavailableException extends DomainException {
  readonly code = ExceptionCode.ServiceUnavailable;
}

@Controller('probe')
class ProbeController {
  @Get('crash/:id')
  crash(@Param('id') _id: string) {
    throw new Error('boom');
  }

  @Get('unavailable')
  unavailable() {
    throw new UnavailableException('Try again shortly.');
  }
}

describe('Error reporting (e2e)', () => {
  let app: INestApplication<App>;
  const reporter = {
    report: vi.fn(),
    shutdown: vi.fn(),
  } satisfies ErrorReporter;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    })
      .overrideProvider(ERROR_REPORTER)
      .useValue(reporter)
      .compile();

    app = moduleFixture.createNestApplication({ bufferLogs: true });
    const logger = app.get(Logger);
    app.useLogger(logger);
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(
      new GlobalExceptionFilter(logger),
      new DomainExceptionFilter(logger),
    );
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    reporter.report.mockClear();
  });

  it('reports a 500 with its route template and correlation id', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/probe/crash/42?token=secret')
      .expect(500);

    expect(reporter.report).toHaveBeenCalledTimes(1);
    const [error, context] = reporter.report.mock.calls[0];
    expect(error).toEqual(new Error('boom'));
    expect(context).toEqual({
      distinctId: undefined,
      level: 'error',
      properties: expect.objectContaining({
        log_context: 'Unhandled exception',
        correlation_id: res.headers['x-correlation-id'],
        method: 'GET',
        route: '/v1/probe/crash/:id',
        status_code: 500,
      }),
    });
    expect(JSON.stringify(context)).not.toContain('secret');
  });

  it('reports an unavailable dependency as a warning', async () => {
    await request(app.getHttpServer()).get('/v1/probe/unavailable').expect(503);

    expect(reporter.report).toHaveBeenCalledWith(
      expect.any(UnavailableException),
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('reports nothing for a client error', async () => {
    await request(app.getHttpServer()).get('/v1/no-such-route').expect(404);

    expect(reporter.report).not.toHaveBeenCalled();
  });
});
