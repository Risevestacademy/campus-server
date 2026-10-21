import { Module } from '@nestjs/common';

import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';

@Module({
  controllers: [CallsController],
  providers: [CallsService],
})
export class CallsModule {}
