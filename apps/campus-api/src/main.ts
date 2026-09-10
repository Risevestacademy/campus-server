import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from 'nestjs-pino';
import { PostHogInterceptor } from 'posthog-node/nestjs';

import { AppModule } from './app.module.js';
import { loadEnv } from './infra/config/env.js';
import { initPostHog } from './infra/posthog/posthog.js';
import { initTelemetry } from './infra/telemetry/telemetry.js';
import { ValidationException } from './shared/exceptions/index.js';
import { DomainExceptionFilter, GlobalExceptionFilter, ValidationExceptionFilter } from './shared/filters/index.js';

function loadApiDescription(): string {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'intro.md'), 'utf8');
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
    apiKey: config.POSTHOG_API_KEY,
    host: config.POSTHOG_HOST,
    enabled: config.FF_POSTHOG_ENABLED,
  });

  // One handler for every resource that needs to flush before exit — each
  // registering its own SIGTERM listener would race, since the first one to
  // call process.exit() cuts off whichever hasn't finished flushing yet.
  process.on('SIGTERM', () => {
    Promise.allSettled([
      config.FF_OTEL_ENABLED ? telemetry.shutdown() : Promise.resolve(),
      posthogClient ? posthogClient.shutdown() : Promise.resolve(),
    ])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('Error during shutdown', result.reason);
          }
        }
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error('Error during shutdown', err);
        process.exit(1);
      });
  });

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  app.setGlobalPrefix('v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => new ValidationException(errors),
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(), new DomainExceptionFilter(), new ValidationExceptionFilter());

  if (posthogClient) {
    app.useGlobalInterceptors(new PostHogInterceptor(posthogClient, { captureExceptions: true }));
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