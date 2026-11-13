import { Module } from '@nestjs/common';

import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import { SessionModule } from '../auth/session.module.js';
import { MEDIA_STORAGE, mediaStorageFrom } from './media-storage.js';
import { MediaService } from './media.service.js';
import { UploadsController } from './uploads.controller.js';

@Module({
  imports: [SessionModule],
  controllers: [UploadsController],
  providers: [
    MediaService,
    {
      provide: MEDIA_STORAGE,
      inject: [CONFIG],
      useFactory: (config: Env) => mediaStorageFrom(config),
    },
  ],
  exports: [MediaService],
})
export class MediaModule {}
