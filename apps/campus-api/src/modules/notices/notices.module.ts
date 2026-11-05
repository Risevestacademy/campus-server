import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import { NoticesController } from './notices.controller.js';
import { NoticesService } from './notices.service.js';

@Module({
  imports: [SessionModule],
  controllers: [NoticesController],
  providers: [NoticesService],
})
export class NoticesModule {}
