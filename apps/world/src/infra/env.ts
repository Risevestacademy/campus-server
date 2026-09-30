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

  /**
   * Read-only: world checks that the account behind a token still exists and
   * is not suspended. The same database campus-api writes.
   */
  DATABASE_URL: z.string().min(1),
  WORLD_DB_POOL: z.coerce.number().int().min(1).default(5),

  /** A socket that misses two of these in a row is considered gone. */
  WORLD_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).default(30),

  /** Largest frame accepted from a client, in bytes. */
  WORLD_MAX_MESSAGE_BYTES: z.coerce.number().int().min(1).default(16_384),

  /**
   * Frames one socket may send per second, whatever they are. A second's
   * worth may arrive at once; the first excess frame closes the socket before
   * parsing. Walking at full speed while pinging uses about half the default.
   */
  WORLD_MAX_MESSAGES_PER_SECOND: z.coerce.number().int().min(1).default(20),

  /**
   * How much may wait unsent to one socket before its client counts as not
   * reading, and is disconnected. The default holds many seconds of a busy
   * room, so only a stalled client reaches it.
   */
  WORLD_MAX_BUFFERED_BYTES: z.coerce.number().int().min(1).default(1_048_576),

  /**
   * The placeholder map, in tiles, until real maps load (W6). Tiles, not
   * pixels: the tile's pixel size is the client's business.
   */
  WORLD_MAP_WIDTH: z.coerce.number().int().min(1).default(40),
  WORLD_MAP_HEIGHT: z.coerce.number().int().min(1).default(30),
  WORLD_SPAWN_X: z.coerce.number().int().min(0).default(20),
  WORLD_SPAWN_Y: z.coerce.number().int().min(0).default(15),

  /**
   * Fastest a player may walk: one tile per this many milliseconds. The
   * client should animate a step over about this long, or a held key will
   * outrun the server and be refused.
   */
  WORLD_STEP_MS: z.coerce.number().int().min(1).default(100),

  /**
   * How often everybody is told who moved. Shorter looks smoother and costs
   * more frames. Below 10ms the loop would be spinning, not batching.
   */
  WORLD_TICK_MS: z.coerce.number().int().min(10).default(50),

  /**
   * How long somebody who dropped out is remembered: reconnect within it and
   * you are back where you stood, not at the spawn. 0 turns it off.
   */
  WORLD_RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(0).default(30),

  /**
   * How recently a login must have been refreshed for its socket to stay
   * open. Must be comfortably longer than campus-api's
   * AUTH_SESSION_TTL_MINUTES (15), since a client refreshes at most once per
   * access token: the default gives it five minutes of slack. Also the
   * furthest a socket can outlive access being taken away.
   */
  WORLD_SESSION_REFRESH_WINDOW_SECONDS: z.coerce.number().int().min(60).default(1200),
}).superRefine((env, ctx) => {
  // A spawn off the map would place every arrival somewhere they could not
  // move from; better to refuse to boot.
  if (env.WORLD_SPAWN_X >= env.WORLD_MAP_WIDTH) {
    ctx.addIssue({
      code: 'custom',
      path: ['WORLD_SPAWN_X'],
      message: 'must be inside WORLD_MAP_WIDTH',
    });
  }
  if (env.WORLD_SPAWN_Y >= env.WORLD_MAP_HEIGHT) {
    ctx.addIssue({
      code: 'custom',
      path: ['WORLD_SPAWN_Y'],
      message: 'must be inside WORLD_MAP_HEIGHT',
    });
  }
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
