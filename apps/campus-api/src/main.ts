import 'reflect-metadata';

import { loadEnv } from './infra/config/env.js';
import { QUIET_ROUTES } from './infra/logger/quiet-routes.js';

// ConfigModule reads .env only once AppModule is imported, which is after this.
try {
  process.loadEnvFile();
} catch {
  // No .env file: the platform provides the variables.
}

const config = loadEnv();

// Telemetry patches modules as they load, so it starts before the app is
// imported. Loaded only when it is on: the SDK is the slowest thing to load
// at boot.
const telemetry = config.FF_OTEL_ENABLED
  ? (await import('@campus/telemetry')).startTelemetry({
      serviceName: config.OTEL_SERVICE_NAME,
      version: config.RAILWAY_GIT_COMMIT_SHA ?? 'local',
      environment: config.DEPLOYMENT_ENVIRONMENT,
      metrics: config.FF_OTEL_METRICS_ENABLED,
      untracedPaths: QUIET_ROUTES,
      esmModules: ['express'],
      instrumentations: [
        new (
          await import('@opentelemetry/instrumentation-express')
        ).ExpressInstrumentation(),
      ],
    })
  : undefined;

const { bootstrap } = await import('./bootstrap.js');
await bootstrap(config, telemetry);
