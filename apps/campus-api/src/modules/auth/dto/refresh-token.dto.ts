import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Where a native app puts its refresh token, having no cookie to send it in.
 * A browser sends no body at all.
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'The refresh token, for a client that holds its tokens itself. Ignored ' +
      'when the refresh cookie is present.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  refreshToken?: string;
}
