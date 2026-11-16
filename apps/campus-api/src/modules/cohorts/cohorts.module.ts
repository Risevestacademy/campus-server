import { Module } from '@nestjs/common';

import { CohortMembersService } from './cohort-members.service.js';

@Module({
  providers: [CohortMembersService],
  exports: [CohortMembersService],
})
export class CohortsModule {}
