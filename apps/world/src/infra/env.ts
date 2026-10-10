import {
  InvalidMediaConfigError,
  assertMediaCredentials,
  type MediaCredentials,
} from '@campus/media';
import { MIN_SESSION_REFRESH_WINDOW_SECONDS } from '@campus/session';
import { z } from 'zod';

/**
 * Validated once, at startup, so a misconfigured deployment fails on boot
 * rather than on the first socket that needs the value. Mirrors campus-api's
 * Env class in intent; zod rather than class-validator because nothing here
 * is a Nest provider.
 */
const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

const optionalText = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const schema = z
  .object({
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
     * Where the campus maps are published. world loads the entry map from here
     * once, at startup, and enforces that version until it restarts. No token:
     * the dataset is public. Required outside development, where a world with
     * no walls would be worse than one that is down. Empty counts as unset.
     */
    SANITY_PROJECT_ID: z
      .string()
      .optional()
      .transform((value) => (value ? value : undefined)),
    SANITY_DATASET: z.string().min(1).default('production'),

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
     * Where each player last stood, kept between visits. Unset keeps nothing:
     * everybody starts at the spawn, beyond the reconnect grace above. Empty
     * counts as unset, so a blank line in a .env file means "off".
     */
    REDIS_URL: z
      .string()
      .optional()
      .transform((value) => (value ? value : undefined)),

    /**
     * How often positions of people who moved are written to Redis, besides
     * whenever somebody's last tab closes. A crash loses at most this much.
     */
    WORLD_POSITION_SAVE_SECONDS: z.coerce.number().int().min(1).default(60),

    /**
     * How long a saved position lasts without a visit. Somebody away longer
     * starts fresh at the spawn, and nothing has to clean up after them.
     */
    WORLD_POSITION_TTL_DAYS: z.coerce.number().int().min(1).default(90),

    /**
     * How long somebody stays present without their instance renewing it,
     * which it does three times within this. So an instance that crashes
     * takes its people out of presence within this long, rather than leaving
     * them online forever.
     */
    WORLD_PRESENCE_TTL_SECONDS: z.coerce.number().int().min(3).default(60),

    /**
     * How recently a login must have been refreshed for its socket to stay
     * open. A client refreshes at least once per access token, and the shared
     * session policy caps those at fifteen minutes, so the window must cover
     * that plus slack — the policy's minimum. Shorter would end sessions that
     * are being refreshed on schedule. Also the furthest a socket can outlive
     * access being taken away.
     */
    WORLD_SESSION_REFRESH_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(MIN_SESSION_REFRESH_WINDOW_SECONDS, {
        message: `must be at least ${MIN_SESSION_REFRESH_WINDOW_SECONDS}: the shared session policy's longest access token plus slack`,
      })
      .default(1200),

    /**
     * The media server (LiveKit) and the key pair that signs for it. All
     * three or none: unset, audio and video are off on this deployment and
     * the routes that need them say so. Empty counts as unset.
     */
    LIVEKIT_URL: optionalText,
    LIVEKIT_API_KEY: optionalText,
    LIVEKIT_API_SECRET: optionalText,

    /** Connection-check tokens one account may be given per minute. */
    WORLD_CONNECTION_CHECKS_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .default(5),
  })
  .superRefine((env, ctx) => {
    const credentials = mediaCredentials(env);
    if (credentials) {
      try {
        assertMediaCredentials(credentials);
      } catch (err) {
        if (!(err instanceof InvalidMediaConfigError)) throw err;
        ctx.addIssue({
          code: 'custom',
          path: ['LIVEKIT_URL'],
          message: err.message,
        });
      }
    } else if (
      env.LIVEKIT_URL ||
      env.LIVEKIT_API_KEY ||
      env.LIVEKIT_API_SECRET
    ) {
      // A mix — a remote URL with the local key, say — mints tokens the
      // server refuses with no hint why.
      ctx.addIssue({
        code: 'custom',
        path: ['LIVEKIT_URL'],
        message:
          'set all of LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET, or none',
      });
    }

    if (
      env.DEPLOYMENT_ENVIRONMENT !== 'development' &&
      !env.SANITY_PROJECT_ID
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SANITY_PROJECT_ID'],
        message: 'is required outside development: the map is loaded from it',
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

/** Undefined when this deployment has no media server. */
export function mediaCredentials(
  env: Pick<Env, 'LIVEKIT_URL' | 'LIVEKIT_API_KEY' | 'LIVEKIT_API_SECRET'>,
): MediaCredentials | undefined {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return undefined;
  }
  return {
    url: env.LIVEKIT_URL,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
  };
}

export function allowedOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
