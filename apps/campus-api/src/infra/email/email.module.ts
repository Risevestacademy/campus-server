import { Global, Module } from '@nestjs/common';
import { Resend } from 'resend';

import { CONFIG } from '../config/config.constants.js';
import type { Env } from '../config/env.js';
import { disabledEmailSender, EMAIL_SENDER } from './email-sender.js';
import { ResendEmailSender } from './resend-email-sender.js';

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      inject: [CONFIG],
      useFactory: (config: Env) =>
        // env.ts requires both values whenever the flag is on.
        config.FF_EMAIL_ENABLED && config.RESEND_API_KEY && config.EMAIL_FROM
          ? new ResendEmailSender(
              new Resend(config.RESEND_API_KEY),
              config.EMAIL_FROM,
            )
          : disabledEmailSender,
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
