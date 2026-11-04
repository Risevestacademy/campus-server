import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import { DesksController } from './desks.controller.js';
import { DesksService } from './desks.service.js';

@Module({
  imports: [SessionModule],
  controllers: [DesksController],
  providers: [DesksService],
})
export class DesksModule {}
