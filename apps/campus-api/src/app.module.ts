import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthModule } from './health/health.module.js';
import { AppConfigModule } from './infra/config/config.module.js';
import { DatabaseModule } from './infra/database/database.module.js';
import { EmailModule } from './infra/email/email.module.js';
import { AppLoggerModule } from './infra/logger/logger.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CohortAdminModule } from './modules/cohorts/cohort-admin.module.js';
import { InvitesModule } from './modules/invites/invites.module.js';
import { TracksModule } from './modules/tracks/tracks.module.js';
import { ProfileModule } from './modules/users/profile/profile.module.js';
import { UserAdminModule } from './modules/users/user-admin.module.js';

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DatabaseModule,
    EmailModule,
    HealthModule,
    AuthModule,
    InvitesModule,
    TracksModule,
    CohortAdminModule,
    UserAdminModule,
    ProfileModule,
    AuditModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
