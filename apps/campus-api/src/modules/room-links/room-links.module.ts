import { Module } from '@nestjs/common';

import { SessionModule } from '../auth/session.module.js';
import {
  RoomLinksController,
  SpaceRoomLinksController,
} from './room-links.controller.js';
import { RoomLinksService } from './room-links.service.js';

@Module({
  imports: [SessionModule],
  controllers: [SpaceRoomLinksController, RoomLinksController],
  providers: [RoomLinksService],
})
export class RoomLinksModule {}
