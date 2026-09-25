import { plainToInstance } from 'class-transformer';
import { Type, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
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
  return env;
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

  @IsOptional()
  @IsEmail()
  DEFAULT_ADMIN_EMAIL?: string;

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

  /** Lifetime of a full-access session, in minutes. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_SESSION_TTL_MINUTES: number = 720;

  /**
   * Lifetime of a provisional session — long enough to finish onboarding,
   * short because it is handed out before anyone has accepted anything.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_PROVISIONAL_TTL_MINUTES: number = 30;

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
