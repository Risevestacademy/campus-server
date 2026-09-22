import { Module } from '@nestjs/common';

import { AdminGuard } from './auth/admin.guard.js';
import { InvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';

@Module({
  controllers: [InvitesController],
  providers: [InvitesService, AdminGuard],
  exports: [InvitesService],
})
export class InvitesModule {}
