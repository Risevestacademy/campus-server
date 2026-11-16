import { Module } from '@nestjs/common';

import {
  MentorOfGroupGuard,
  ProfessorOfTrackGuard,
} from './cohort-role.guard.js';
import { CohortRoleService } from './cohort-role.service.js';

/**
 * The cohort-role guards and their one lookup. Feature modules import this
 * and put the guard in @UseGuards beside SessionGuard.
 */
@Module({
  providers: [CohortRoleService, ProfessorOfTrackGuard, MentorOfGroupGuard],
  exports: [CohortRoleService, ProfessorOfTrackGuard, MentorOfGroupGuard],
})
export class CohortRoleModule {}
