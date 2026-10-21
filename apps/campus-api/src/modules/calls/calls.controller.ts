import { InvalidWebhookError, verifyCallWebhook } from '@campus/media';
import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import {
  CallWebhookUnverifiedException,
  CallWebhooksNotConfiguredException,
} from './calls.exceptions.js';
import { CallsService } from './calls.service.js';
import { ApiCallWebhook } from './docs/calls.docs.js';

@ApiTags('calls')
@Controller('calls')
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    @Inject(CONFIG) private readonly config: Env,
  ) {}

  // LiveKit sends every event of every call here; a call's worth of joins
  // in a minute is not abuse.
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCallWebhook()
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const {
      LIVEKIT_WEBHOOK_API_KEY: apiKey,
      LIVEKIT_WEBHOOK_API_SECRET: apiSecret,
    } = this.config;
    if (!apiKey || !apiSecret) {
      throw new CallWebhooksNotConfiguredException(
        'Call webhooks are not configured here',
      );
    }
    let verified;
    try {
      verified = await verifyCallWebhook(
        { apiKey, apiSecret },
        request.rawBody?.toString('utf8') ?? '',
        authorization,
      );
    } catch (err: unknown) {
      if (err instanceof InvalidWebhookError) {
        throw new CallWebhookUnverifiedException(err.message);
      }
      throw err;
    }
    if (verified.event) {
      await this.calls.record(verified.event, verified.at);
    }
  }
}
