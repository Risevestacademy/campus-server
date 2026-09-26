import { z } from 'zod';

/**
 * Validated once, at startup, so a misconfigured deployment fails on boot
 * rather than on the first socket that needs the value. Mirrors campus-api's
 * Env class in intent; zod rather than class-validator because nothing here
 * is a Nest provider.
 */
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

const flag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const schema = z.object({
  PORT: z.coerce.number().int().min(1).default(3001),
  DEPLOYMENT_ENVIRONMENT: z.string().default('development'),

  FF_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  FF_LOG_PRETTY: flag.default(false),

  /**
   * Browser origins allowed to open a socket. A WebSocket upgrade is not
   * subject to CORS, so this is the only thing standing between the campus
   * and a socket opened from any page the user happens to have open.
   */
  CORS_ORIGINS: z.string().default(''),

  /** Shared with campus-api, which signs the tokens this service verifies. */
  AUTH_SESSION_SECRET: z.string().min(32),

  /** A socket that misses two of these in a row is considered gone. */
  WORLD_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).default(30),

  /** Largest frame accepted from a client, in bytes. */
  WORLD_MAX_MESSAGE_BYTES: z.coerce.number().int().min(1).default(16_384),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment variables: ${detail}`);
  }
  return parsed.data;
}

export function allowedOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
