import { Module } from '@nestjs/common';

import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import { SessionModule } from '../auth/session.module.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';
import { RecordingsController } from './recordings.controller.js';
import { RECORDING_MEDIA, recordingMediaFrom } from './recording-media.js';
import { RecordingsService } from './recordings.service.js';

@Module({
  imports: [SessionModule],
  controllers: [CallsController, RecordingsController],
  providers: [
    CallsService,
    RecordingsService,
    {
      provide: RECORDING_MEDIA,
      inject: [CONFIG],
      useFactory: (config: Env) => recordingMediaFrom(config),
    },
  ],
})
export class CallsModule {}
