import { Global, Module } from '@nestjs/common';

import { Scheduler } from './scheduler.js';

@Global()
@Module({ providers: [Scheduler], exports: [Scheduler] })
export class SchedulerModule {}
