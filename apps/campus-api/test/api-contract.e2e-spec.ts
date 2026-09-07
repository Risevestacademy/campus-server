import { Controller, Get, INestApplication, Query } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { PaginationQueryDto } from './../src/shared/dto/index.js';
import { ValidationException } from './../src/shared/exceptions/index.js';
import { DomainExceptionFilter, GlobalExceptionFilter, ValidationExceptionFilter } from './../src/shared/filters/index.js';

@Controller('list')
class ListController {
  @Get()
  index(@Query() query: PaginationQueryDto): PaginationQueryDto {
    return query;
  }
}

@Controller('tracked')
class TrackedController {
  @Get()
  index(): string {
    return 'ok';
  }
}

describe('API contract (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 1000, limit: 2 }])],
      controllers: [ListController, TrackedController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        exceptionFactory: (errors) => new ValidationException(errors),
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter(), new DomainExceptionFilter(), new ValidationExceptionFilter());
    await app.init();
  });

  it('GET /v1/list applies pagination defaults', () => {
    return request(app.getHttpServer())
      .get('/v1/list')
      .expect(200)
      .expect({ page: 1, perPage: 20 });
  });

  it('GET /v1/list transforms string query params to numbers', () => {
    return request(app.getHttpServer())
      .get('/v1/list?page=2&perPage=50')
      .expect(200)
      .expect({ page: 2, perPage: 50 });
  });

  it('GET /v1/list rejects out-of-range perPage with our error contract', () => {
    return request(app.getHttpServer())
      .get('/v1/list?perPage=500')
      .expect(400)
      .expect({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Request validation failed',
          details: {
            fields: {
              perPage: 'perPage must not be greater than 100',
            },
          },
        },
      });
  });

  it('throttling returns our error contract with RATE_LIMITED', async () => {
    const server = app.getHttpServer();
    await request(server).get('/v1/tracked').expect(200);
    await request(server).get('/v1/tracked').expect(200);
    return request(server)
      .get('/v1/tracked')
      .expect(429)
      .expect({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, retry later.',
        },
      });
  });

  afterEach(async () => {
    await app.close();
  });
});