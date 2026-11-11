import { Module } from '@nestjs/common';

import { AttendanceTallyService } from './attendance-tally.service.js';

@Module({
  providers: [AttendanceTallyService],
})
export class AttendanceModule {}
