import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiEnterRoomLink } from './docs/room-links.docs.js';
import { RoomLinkCodeParamDto, RoomLinkEntryDto } from './dto/room-link.dto.js';
import { RoomLinkEntryService } from './room-link-entry.service.js';

@ApiTags('room-links')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('room-links')
export class RoomLinkEntryController {
  constructor(private readonly entry: RoomLinkEntryService) {}

  @Post(':code/enter')
  @HttpCode(HttpStatus.OK)
  @ApiEnterRoomLink()
  enter(
    @Param() params: RoomLinkCodeParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomLinkEntryDto> {
    return this.entry.enter(user, params.code);
  }
}
