import type { Telemetry } from '@campus/telemetry';
import type { HttpServer } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import {
  ANALYTICS,
  type Analytics,
} from './infra/analytics/analytics.module.js';
import { parseCorsOrigins, type Env } from './infra/config/env.js';
import {
  ERROR_REPORTER,
  type ErrorReporter,
} from './infra/error-reporting/error-reporting.module.js';
import { CORRELATION_ID_HEADER } from './infra/logger/logger.module.js';
import { gracefulShutdown } from './infra/shutdown.js';
import { ValidationException } from './shared/exceptions/index.js';
import {
  DomainExceptionFilter,
  GlobalExceptionFilter,
  ValidationExceptionFilter,
} from './shared/filters/index.js';

function loadApiDescription(): string {
  try {
    return readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'intro.md'),
      'utf8',
    );
  } catch {
    return 'Campus API. See the integration guide in docs/intro.md for conventions.';
  }
}

export async function bootstrap(
  config: Env,
  telemetry?: Telemetry,
  exitProcess: (code: number) => void = (code) => process.exit(code),
) {
  let app: NestExpressApplication | undefined;
  let logger: Logger | undefined;
  let reporter: ErrorReporter | undefined;
  let analytics: Analytics | undefined;

  /** Closes the app, then sends what telemetry and PostHog still hold. */
  async function exit(code: number): Promise<void> {
    try {
      await gracefulShutdown(app, [
        () => (telemetry ? telemetry.shutdown() : Promise.resolve()),
        () => (reporter ? reporter.shutdown() : Promise.resolve()),
        () => (analytics ? analytics.shutdown() : Promise.resolve()),
      ]);
    } catch (err) {
      console.error('Error during shutdown', err);
      code = 1;
    }
    exitProcess(code);
  }

  process.on('SIGTERM', () => {
    void exit(0);
  });

  try {
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bufferLogs: true,
      rawBody: true,
    });
    // LiveKit posts its webhooks as application/webhook+json, signed over the
    // raw body. Registering a json parser replaces Nest's default one, so it
    // has to take application/json too.
    app.useBodyParser('json', {
      type: ['application/json', 'application/webhook+json'],
    });

    const appLogger = app.get(Logger);
    logger = appLogger;
    app.useLogger(appLogger);
    reporter = app.get<ErrorReporter>(ERROR_REPORTER);
    analytics = app.get<Analytics>(ANALYTICS);

    await configureAndListen(app, config, appLogger);
  } catch (err) {
    // Through the Nest logger once there is one, so it is reported; before
    // that, nothing reports it, and the exit flushes telemetry alone.
    if (logger) {
      logger.error({ err }, 'Failed to start', 'bootstrap');
    } else {
      console.error('Failed to start', err);
    }
    await exit(1);
  }
}

async function configureAndListen(
  app: NestExpressApplication,
  config: Env,
  logger: Logger,
) {
  // Without this every request appears to come from the proxy

  app.set('trust proxy', config.TRUST_PROXY_HOPS);

  const corsOrigins = parseCorsOrigins(config.CORS_ORIGINS);
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      credentials: true,
      exposedHeaders: [CORRELATION_ID_HEADER],
    });
  }

  app.setGlobalPrefix('v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => new ValidationException(errors),
    }),
  );
  app.useGlobalFilters(
    new GlobalExceptionFilter(logger),
    new DomainExceptionFilter(logger),
    new ValidationExceptionFilter(),
  );

  const documentConfig = new DocumentBuilder()
    .setTitle('campus-api')
    .setDescription(loadApiDescription())
    .setVersion('0.0.1')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);

  app.use(
    '/docs',
    apiReference({
      content: document,
      theme: 'purple',
    }),
  );

  const httpAdapter: HttpServer = app.getHttpAdapter();
  httpAdapter.get('/docs-json', (_req, res) => {
    res.json(document);
  });

  await app.listen(process.env.PORT ?? config.PORT);
}
