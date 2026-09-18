import 'reflect-metadata';

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
import { loadEnv, parseCorsOrigins } from './infra/config/env.js';
import { initPostHog } from './infra/posthog/posthog.js';
import { PostHogExceptionInterceptor } from './infra/posthog/posthog.interceptor.js';
import { CORRELATION_ID_HEADER } from './infra/logger/logger.module.js';
import { gracefulShutdown } from './infra/shutdown.js';
import { initTelemetry } from './infra/telemetry/telemetry.js';
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

async function bootstrap() {
  const config = loadEnv();
  const telemetry = initTelemetry({
    serviceName: config.OTEL_SERVICE_NAME,
    version: '1.0.0',
    environment: config.DEPLOYMENT_ENVIRONMENT,
    enabled: config.FF_OTEL_ENABLED,
    metricsEnabled: config.FF_OTEL_METRICS_ENABLED,
  });
  const posthogClient = initPostHog({
    apiKey: config.POSTHOG_PROJECT_TOKEN,
    host: config.POSTHOG_HOST,
    enabled: config.FF_POSTHOG_ENABLED,
  });

  let app: NestExpressApplication | undefined;

  process.on('SIGTERM', () => {
    gracefulShutdown(app, [
      () => (config.FF_OTEL_ENABLED ? telemetry.shutdown() : Promise.resolve()),
      () => (posthogClient ? posthogClient.shutdown() : Promise.resolve()),
    ])
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('Error during shutdown', err);
        process.exit(1);
      });
  });

  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

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
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );

  if (posthogClient) {
    app.useGlobalInterceptors(new PostHogExceptionInterceptor(posthogClient));
  }

  const documentConfig = new DocumentBuilder()
    .setTitle('campus-api')
    .setDescription(loadApiDescription())
    .setVersion('0.0.1')
    .addServer('/v1')
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

  app.getHttpAdapter().get('/docs-json', (_req, res) => {
    res.json(document);
  });

  await app.listen(process.env.PORT ?? config.PORT);
}
await bootstrap();
