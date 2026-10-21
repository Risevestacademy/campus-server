import { Module } from '@nestjs/common';

import {
  MentorOfGroupGuard,
  ProfessorOfTrackGuard,
  ProfessorOfTrackOrMentorOfGroupGuard,
} from './cohort-role.guard.js';
import { CohortRoleService } from './cohort-role.service.js';

/**
 * The cohort-role guards and their one lookup. Feature modules import this
 * and put the guard in @UseGuards beside SessionGuard.
 */
@Module({
  providers: [
    CohortRoleService,
    ProfessorOfTrackGuard,
    MentorOfGroupGuard,
    ProfessorOfTrackOrMentorOfGroupGuard,
  ],
  exports: [
    CohortRoleService,
    ProfessorOfTrackGuard,
    MentorOfGroupGuard,
    ProfessorOfTrackOrMentorOfGroupGuard,
  ],
})
export class CohortRoleModule {}
