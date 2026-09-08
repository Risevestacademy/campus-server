import { Test, TestingModule } from '@nestjs/testing';
import {
  Body,
  Controller,
  INestApplication,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { IsEmail, IsNotEmpty } from 'class-validator';

import { AppModule } from './../src/app.module.js';
import { ValidationException } from './../src/shared/exceptions/index.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './../src/shared/filters/index.js';

class CreateUserDto {
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;
}

@Controller('test')
class TestController {
  @Post()
  create(@Body() dto: CreateUserDto) {
    return { created: dto.name };
  }
}

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestController],
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
    app.useGlobalFilters(
      new GlobalExceptionFilter(),
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();
  });

  it('/v1/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/v1/')
      .expect(200)
      .expect('Hello World!');
  });

  it('POST /v1/test with an invalid payload returns our error contract with field details', () => {
    return request(app.getHttpServer())
      .post('/v1/test')
      .send({ name: '', email: 'not-an-email' })
      .expect(400)
      .expect({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Request validation failed',
          details: {
            fields: {
              name: 'name should not be empty',
              email: 'email must be an email',
            },
          },
        },
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
