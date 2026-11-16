import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import { AttendanceTallyService } from './attendance-tally.service.js';
import {
  AttendanceController,
  CohortAttendanceController,
} from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';

@Module({
  imports: [SessionModule],
  controllers: [CohortAttendanceController, AttendanceController],
  providers: [AttendanceTallyService, AttendanceService],
})
export class AttendanceModule {}
