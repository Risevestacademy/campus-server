import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { SessionModule } from '../auth/session.module.js';
import { TracksController } from './tracks.controller.js';
import { TracksService } from './tracks.service.js';

@Module({
  imports: [SessionModule],
  controllers: [TracksController],
  providers: [TracksService, AdminGuard],
})
export class TracksModule {}
