import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  redis,
  service,
  volume,
} from 'railway/iac';

export const partial = 'campus-backend';

/**
 * V8 sizes its heap from the memory it can see, and a container shows it far
 * more than either service uses, so unbounded it holds on to memory it never
 * needs. Flags on the command rather than NODE_OPTIONS, so the pre-deploy
 * migration does not run under the same cap.
 */
const API_START =
  'node --max-old-space-size=128 --max-semi-space-size=2 apps/campus-api/dist/main.js';
const WORLD_START =
  'node --max-old-space-size=96 --max-semi-space-size=2 apps/world/dist/index.js';

export default defineRailway((ctx) => {
  // Staging only. Production has a different shape (no Redis, its own
  // domains, the main branch) that this file does not describe, so applying
  // it there would rewrite most of that environment.
  if (!ctx.isEnvironment('staging')) {
    throw new Error(
      `.railway/railway.ts describes staging only; refusing to plan for "${ctx.environmentName ?? ctx.environment}"`,
    );
  }

  const campusServer = github('Risevestacademy/campus-server', {
    branch: 'dev',
    checkSuites: true,
  });

  const Postgres = postgres('Postgres', { region: 'ams' });
  Postgres.networking = { privateNetworkEndpoint: 'postgres' };
  const Redis = redis('Redis', { region: 'ams' });
  Redis.deploy = {
    startCommand:
      '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
  };
  Redis.networking = { privateNetworkEndpoint: 'redis' };
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'ams',
    sizeMB: 5000,
  });
  const redisVolumeMQr = volume('redis-volume-mQr-', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'ams',
    sizeMB: 5000,
  });
  const campusWorld = service('campus-world', {
    source: campusServer,
    build: {
      buildCommand:
        'pnpm install --frozen-lockfile && pnpm --filter "world..." build',
      buildEnvironment: 'V3',
      builder: 'RAILPACK',
      watchPatterns: [
        '/apps/world/**',
        '/packages/media/**',
        '/packages/session/**',
        '/package.json',
        '/pnpm-lock.yaml',
        '/pnpm-workspace.yaml',
      ],
    },
    // node directly: started through pnpm, the wrapper stays alive as the
    // parent and holds more memory than world itself.
    start: WORLD_START,
    healthcheck: '/health',
    replicas: { ams: 1 },
    domains: ['ws.dev.campusbyrise.com'],
    env: {
      AUTH_SESSION_SECRET: preserve(),
      CORS_ORIGINS: preserve(),
      DATABASE_URL: preserve(),
      DEPLOYMENT_ENVIRONMENT: preserve(),
      LIVEKIT_API_KEY: preserve(),
      LIVEKIT_API_SECRET: preserve(),
      LIVEKIT_URL: preserve(),
      REDIS_URL: preserve(),
      SANITY_DATASET: 'staging',
      SANITY_PROJECT_ID: 'sj3zsz66',
      WORLD_HEARTBEAT_SECONDS: preserve(),
      WORLD_MAX_MESSAGE_BYTES: preserve(),
    },
  });
  const campusApi = service('campus-api', {
    source: campusServer,
    build: {
      buildCommand:
        'pnpm install --frozen-lockfile && pnpm --filter "campus-api..." build',
      buildEnvironment: 'V3',
      builder: 'RAILPACK',
      watchPatterns: [
        '/apps/campus-api/**',
        '/packages/session/**',
        '/package.json',
        '/pnpm-lock.yaml',
        '/pnpm-workspace.yaml',
      ],
    },
    start: API_START,
    // Serverless: asleep, and unbilled, once it has sent nothing for a few
    // minutes; the next request wakes it. Only the API. World holds sockets
    // open and Postgres holds the data, so both stay up.
    deploy: { sleepApplication: true },
    healthcheck: '/v1/health',
    preDeploy:
      'pnpm --filter campus-api db:migrate && pnpm --filter campus-api db:seed',
    replicas: { ams: 1 },
    domains: ['api.dev.campusbyrise.com'],
    networking: { privateNetworkEndpoint: 'campus-server' },
    env: {
      APP_PUBLIC_URL: preserve(),
      AUTH_COOKIE_DOMAIN: preserve(),
      AUTH_PROVISIONAL_TTL_MINUTES: preserve(),
      AUTH_REFRESH_TTL_DAYS: preserve(),
      AUTH_SESSION_SECRET: preserve(),
      AUTH_SESSION_TTL_MINUTES: preserve(),
      AUTH_STATE_SECRET: preserve(),
      CORS_ORIGINS: preserve(),
      DATABASE_URL: preserve(),
      DEFAULT_ADMIN_EMAIL: preserve(),
      DEPLOYMENT_ENVIRONMENT: preserve(),
      EMAIL_FROM: preserve(),
      FF_EMAIL_ENABLED: preserve(),
      FF_GOOGLE_AUTH_ENABLED: preserve(),
      FF_LOG_LEVEL: preserve(),
      FF_LOG_PRETTY: preserve(),
      FF_OTEL_ENABLED: preserve(),
      FF_OTEL_METRICS_ENABLED: preserve(),
      FF_POSTHOG_ENABLED: preserve(),
      GOOGLE_CALLBACK_URL: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      GOOGLE_MOBILE_CLIENT_IDS: preserve(),
      INVITE_TTL_DAYS: preserve(),
      OTEL_SERVICE_NAME: preserve(),
      PORT: preserve(),
      POSTHOG_HOST: preserve(),
      POSTHOG_PROJECT_TOKEN: preserve(),
      RESEND_API_KEY: preserve(),
      RESEND_INVITE_ADMIN_TEMPLATE_ID: preserve(),
      RESEND_INVITE_GUEST_TEMPLATE_ID: preserve(),
      RESEND_INVITE_TEMPLATE_ID: preserve(),
      SANITY_DATASET: 'staging',
      SANITY_PROJECT_ID: 'sj3zsz66',
      TRUST_PROXY_HOPS: preserve(),
    },
  });

  return project('campus-by-rise', {
    resources: [
      Postgres,
      Redis,
      campusWorld,
      campusApi,
      postgresVolume,
      redisVolumeMQr,
    ],
  });
});
