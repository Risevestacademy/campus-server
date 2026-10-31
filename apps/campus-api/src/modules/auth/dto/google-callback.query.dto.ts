import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GoogleCallbackQueryDto {
  /** One-time authorization code to exchange with Google. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  code?: string;

  /** The signed state issued when the sign-in started. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  state?: string;

  /**
   * Set when the user declined at the Google consent screen.
   * @example access_denied
   */
  @IsOptional()
  @IsString()
  error?: string;
}
