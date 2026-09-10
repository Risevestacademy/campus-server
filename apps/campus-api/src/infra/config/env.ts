import { plainToInstance } from 'class-transformer';
import { Type, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

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
  @Matches(/^phc_/, { message: 'POSTHOG_API_KEY must start with "phc_"' })
  POSTHOG_API_KEY?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  POSTHOG_HOST: string = 'https://us.i.posthog.com';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === '') return false;
    return value === 'true' || value === true;
  })
  @IsBoolean()
  FF_POSTHOG_ENABLED: boolean = false;
}