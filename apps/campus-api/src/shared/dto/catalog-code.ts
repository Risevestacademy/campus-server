import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * The short code a track or cohort is known by: trimmed and uppercased on the
 * way in, so `se` and `SE` name the same thing and the tables' uppercase CHECK
 * is never what refuses a request.
 */
export function IsCatalogCode(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toUpperCase() : value,
    ),
    IsString(),
    IsNotEmpty(),
    MaxLength(32),
    Matches(/^[A-Z0-9][A-Z0-9_-]*$/, {
      message:
        'code may contain only letters, digits, hyphens and underscores, and must start with a letter or digit',
    }),
  );
}
