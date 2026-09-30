import { MAX_ACCESS_TOKEN_TTL_MINUTES } from '@campus/session';
import { plainToInstance } from 'class-transformer';
import { Type, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsFQDN,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

export function loadEnv(source: Record<string, unknown> = process.env): Env {
  const env = plainToInstance(Env, source, {});
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const message = errors
      .map((error) => Object.values(error.constraints ?? {}).join('; '))
      .join('; ');
    throw new Error(`Invalid environment variables: ${message}`);
  }
  assertCookieDomainCovers(env);
  return env;
}

/**
 * A browser silently drops a cookie whose Domain does not cover the host that
 * set it, so a mistyped AUTH_COOKIE_DOMAIN would sign nobody in and say
 * nothing. Both hosts are checked: the callback sets the cookie, and the app
 * is where it has to be sent from.
 */
function assertCookieDomainCovers(env: Env): void {
  const domain = env.AUTH_COOKIE_DOMAIN;
  if (!domain) {
    return;
  }
  const hosts = [env.APP_PUBLIC_URL, env.GOOGLE_CALLBACK_URL]
    .filter((url): url is string => Boolean(url))
    .map((url) => new URL(url).hostname);
  for (const host of hosts) {
    if (host !== domain && !host.endsWith(`.${domain}`)) {
      throw new Error(
        `Invalid environment variables: AUTH_COOKIE_DOMAIN ${domain} does not cover ${host}`,
      );
    }
  }
}

/**
 * Comma-separated addresses, trimmed, lowercased (how USERS stores them) and
 * de-duplicated. Undefined when nothing is left, so an empty variable reads
 * as unset.
 */
export function parseEmailList(value: string): string[] | undefined {
  const emails = [
    ...new Set(
      value
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0),
    ),
  ];
  return emails.length > 0 ? emails : undefined;
}

export function parseCorsOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export class Env {
  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PORT: number = 3000;

  @IsNotEmpty()
  @IsString()
  DATABASE_URL: string = 'postgresql://postgres:postgres@localhost:5432/campus';

  /**
   * The admins `db:seed` creates or promotes: one address, or several
   * separated by commas. The API itself never reads it.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? parseEmailList(value) : value,
  )
  @IsEmail(
    {},
    {
      each: true,
      message:
        'DEFAULT_ADMIN_EMAIL must be one or more email addresses, separated by commas',
    },
  )
  DEFAULT_ADMIN_EMAIL?: string[];

  // Google sign-in ------------------------------------------------------
  // Flag-gated the same way PostHog is, so the API still boots on an empty
  // environment. Turn the flag on and all four values below become required:
  // a deployment that claims to do Google sign-in and cannot is worse than
  // one that never claimed to.

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === '') return false;
    return value === 'true' || value === true;
  })
  @IsBoolean()
  FF_GOOGLE_AUTH_ENABLED: boolean = false;

  @ValidateIf((o: Env) => o.FF_GOOGLE_AUTH_ENABLED)
  @IsNotEmpty()
  @IsString()
  GOOGLE_CLIENT_ID?: string;

  /** Web-application client only. Android and iOS clients hold no secret. */
  @ValidateIf((o: Env) => o.FF_GOOGLE_AUTH_ENABLED)
  @IsNotEmpty()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string;

  /**
   * Must point at this API, not at the web app, and must match a redirect URI
   * registered on the same Google client byte for byte.
   */
  // `require_tld: false` so a localhost callback is legal; `require_protocol`
  // because Google matches the redirect URI as a literal string, and a bare
  // hostname can never match what is registered.
  @ValidateIf((o: Env) => o.FF_GOOGLE_AUTH_ENABLED)
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  GOOGLE_CALLBACK_URL?: string;

  /**
   * Signs the OAuth `state` parameter. Rotating it invalidates sign-ins that
   * are mid-flight, which is a few seconds of inconvenience, never a lockout.
   */
  @ValidateIf((o: Env) => o.FF_GOOGLE_AUTH_ENABLED)
  @IsString()
  @MinLength(32, {
    message: 'AUTH_STATE_SECRET must be at least 32 characters',
  })
  AUTH_STATE_SECRET?: string;

  /**
   * Signs session tokens. Separate from AUTH_STATE_SECRET because the two
   * protect different things for different lifetimes — rotating this one
   * signs every session out, which is the point of being able to.
   */
  @ValidateIf((o: Env) => o.FF_GOOGLE_AUTH_ENABLED)
  @IsString()
  @MinLength(32, {
    message: 'AUTH_SESSION_SECRET must be at least 32 characters',
  })
  AUTH_SESSION_SECRET?: string;

  /**
   * Lifetime of a full-access session's access token, in minutes. Capped by
   * the shared session policy: world keeps a socket open while the sign-in
   * behind it keeps being refreshed, and it can only tell how often that
   * should be because no token here lives longer than the cap.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ACCESS_TOKEN_TTL_MINUTES, {
    message: `AUTH_SESSION_TTL_MINUTES must be at most ${MAX_ACCESS_TOKEN_TTL_MINUTES}, the shared session policy's cap`,
  })
  AUTH_SESSION_TTL_MINUTES: number = MAX_ACCESS_TOKEN_TTL_MINUTES;

  /**
   * Lifetime of a provisional session — long enough to finish onboarding,
   * short because it is handed out before anyone has accepted anything.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_PROVISIONAL_TTL_MINUTES: number = 30;

  /** Lifetime of a revocable refresh token, in days. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_REFRESH_TTL_DAYS: number = 30;

  /**
   * Parent domain for the session cookie, so `world` on a sibling subdomain
   * receives it (`campus.example` covers `world.campus.example`). Unset keeps
   * the cookie host-only, which is right until world has its own hostname.
   * The refresh and state cookies stay host-only either way.
   */
  @IsOptional()
  @IsFQDN(
    {},
    {
      message: 'AUTH_COOKIE_DOMAIN must be a bare domain, like campus.example',
    },
  )
  AUTH_COOKIE_DOMAIN?: string;

  // Comma-separated list of browser origins allowed to call the API.

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  TRUST_PROXY_HOPS: number = 1;

  @IsOptional()
  @IsIn(LOG_LEVELS)
  FF_LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === '') return false;
    return value === 'true' || value === true;
  })
  @IsBoolean()
  FF_LOG_PRETTY: boolean = false;

  @IsOptional()
  @IsString()
  DEPLOYMENT_ENVIRONMENT: string = 'development';

  @IsOptional()
  @IsString()
  OTEL_SERVICE_NAME: string = 'campus-api';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === '') return true;
    return value === 'true' || value === true;
  })
  @IsBoolean()
  FF_OTEL_ENABLED: boolean = true;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === '') return true;
    return value === 'true' || value === true;
  })
  @IsBoolean()
  FF_OTEL_METRICS_ENABLED: boolean = true;

  @ValidateIf((o: Env) => o.FF_POSTHOG_ENABLED)
  @IsNotEmpty()
  @Matches(/^phc_/, { message: 'POSTHOG_PROJECT_TOKEN must start with "phc_"' })
  POSTHOG_PROJECT_TOKEN?: string;

  @ValidateIf((o: Env) => o.FF_POSTHOG_ENABLED)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  POSTHOG_HOST: string = 'https://eu.i.posthog.com';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === '') return false;
    return value === 'true' || value === true;
  })
  @IsBoolean()
  FF_POSTHOG_ENABLED: boolean = false;

  // Email (Resend) ------------------------------------------------------
  // Off by default, like PostHog: local development and CI never send mail.
  // With the flag off, invites are still created and the admin shares the
  // link by hand, which is how it worked before email existed.

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === '') return false;
    return value === 'true' || value === true;
  })
  @IsBoolean()
  FF_EMAIL_ENABLED: boolean = false;

  @ValidateIf((o: Env) => o.FF_EMAIL_ENABLED)
  @IsNotEmpty()
  @Matches(/^re_/, { message: 'RESEND_API_KEY must start with "re_"' })
  RESEND_API_KEY?: string;

  /** The sender: a bare address or `Name <address>`. */
  @ValidateIf((o: Env) => o.FF_EMAIL_ENABLED)
  @Matches(
    /^(?:[^<>]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/,
    {
      message: 'EMAIL_FROM must be an address, or "Name <address>"',
    },
  )
  EMAIL_FROM?: string;

  // require_tld: false keeps http://localhost:3000 valid for local dev;
  // require_protocol: true still rejects bare words like "not-a-url".
  @IsUrl({ require_tld: false, require_protocol: true })
  APP_PUBLIC_URL: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  INVITE_TTL_DAYS: number = 7;
}
