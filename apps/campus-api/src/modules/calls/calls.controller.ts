import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CallsService } from './calls.service.js';
import { ApiCallWebhook } from './docs/calls.docs.js';

@ApiTags('calls')
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  // LiveKit sends every event of every call here; a call's worth of joins
  // in a minute is not abuse.
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCallWebhook()
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    return this.calls.receive(
      request.rawBody?.toString('utf8') ?? '',
      authorization,
    );
  }
}
