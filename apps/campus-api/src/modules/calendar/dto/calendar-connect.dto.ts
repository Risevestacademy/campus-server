import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CalendarCallbackQueryDto {
  @ApiPropertyOptional({ description: 'Authorization code from Google.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  code?: string;

  @ApiPropertyOptional({
    description: 'The state issued by GET /v1/calendar/connect.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  state?: string;

  @ApiPropertyOptional({
    description: 'Set when the member declined at Google.',
    example: 'access_denied',
  })
  @IsOptional()
  @IsString()
  error?: string;
}

export class CalendarAppConnectDto {
  @ApiProperty({
    description:
      'The server auth code Google’s SDK gave the app for ' +
      '`calendar.events.readonly` and `openid`, with offline access and ' +
      'force-refresh-token on, for the web client (GOOGLE_CLIENT_ID).',
  })
  @IsString()
  @IsNotEmpty()
  serverAuthCode!: string;
}
