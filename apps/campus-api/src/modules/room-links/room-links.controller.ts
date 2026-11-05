import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { InvalidArgumentException } from '../../shared/exceptions/index.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiCreateRoomLink,
  ApiListRoomLinks,
  ApiOpenRoomLink,
  ApiRevokeRoomLink,
  ApiSetRoomLinkWindow,
} from './docs/room-links.docs.js';
import {
  CreateRoomLinkDto,
  RoomLinkCodeParamDto,
  RoomLinkDto,
  RoomLinkSpaceParamDto,
  RoomLinkWindowDto,
} from './dto/room-link.dto.js';
import { RoomLinksService, type RoomLinkWindow } from './room-links.service.js';

@ApiTags('room-links')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('cohorts/:cohortId/spaces/:spaceId/links')
export class SpaceRoomLinksController {
  constructor(private readonly links: RoomLinksService) {}

  @Post()
  @ApiCreateRoomLink()
  create(
    @Param() params: RoomLinkSpaceParamDto,
    @Body() body: CreateRoomLinkDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<RoomLinkDto> {
    return this.links.create(
      user,
      params.cohortId,
      params.spaceId,
      body.title,
      windowOf(body),
      { actorUserId: user.id, correlationId },
    );
  }

  @Get()
  @ApiListRoomLinks()
  list(
    @Param() params: RoomLinkSpaceParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomLinkDto[]> {
    return this.links.list(user, params.cohortId, params.spaceId);
  }
}

@ApiTags('room-links')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('room-links')
export class RoomLinksController {
  constructor(private readonly links: RoomLinksService) {}

  @Get(':code')
  @ApiOpenRoomLink()
  open(
    @Param() params: RoomLinkCodeParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomLinkDto> {
    return this.links.open(user, params.code);
  }

  @Put(':code/window')
  @ApiSetRoomLinkWindow()
  setWindow(
    @Param() params: RoomLinkCodeParamDto,
    @Body() body: RoomLinkWindowDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<RoomLinkDto> {
    return this.links.setWindow(user, params.code, windowOf(body), {
      actorUserId: user.id,
      correlationId,
    });
  }

  @Delete(':code')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiRevokeRoomLink()
  revoke(
    @Param() params: RoomLinkCodeParamDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<void> {
    return this.links.revoke(user, params.code, {
      actorUserId: user.id,
      correlationId,
    });
  }
}

/** Both times or neither; the service checks their order. */
function windowOf(body: RoomLinkWindowDto): RoomLinkWindow | null {
  if (body.startsAt === undefined && body.endsAt === undefined) {
    return null;
  }
  if (body.startsAt === undefined || body.endsAt === undefined) {
    throw new InvalidArgumentException(
      'A window needs both startsAt and endsAt, or neither',
    );
  }
  return { startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt) };
}
