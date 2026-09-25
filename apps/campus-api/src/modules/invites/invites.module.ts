import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';

import { AdminGuard } from './auth/admin.guard.js';
import { InvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';

@Module({
  imports: [SessionModule],
  controllers: [InvitesController],
  providers: [InvitesService, AdminGuard],
  exports: [InvitesService],
})
export class InvitesModule {}
