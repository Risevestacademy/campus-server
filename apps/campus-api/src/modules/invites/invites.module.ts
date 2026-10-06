import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import { CohortsModule } from '../cohorts/cohorts.module.js';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { InviteFlagNotifier } from './invite-flag-notifier.js';
import { InviteImportService } from './invite-import.service.js';
import { InviteMailer } from './invite-mailer.js';
import { InvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';

@Module({
  imports: [CohortsModule, SessionModule],
  controllers: [InvitesController],
  providers: [
    InvitesService,
    InviteMailer,
    InviteFlagNotifier,
    AdminGuard,
    InviteImportService,
  ],
  exports: [InvitesService],
})
export class InvitesModule {}
