import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiCreateTrack, ApiListTracks } from './docs/tracks.docs.js';
import { CreateTrackDto } from './dto/create-track.dto.js';
import { TrackResponseDto } from './dto/track-response.dto.js';
import { TracksService } from './tracks.service.js';

@ApiTags('tracks')
@ApiBearerAuth()
// SessionGuard authenticates and sets req.user; AdminGuard reads it. Guards
// run left to right, so the order matters.
@UseGuards(SessionGuard, AdminGuard)
@Controller('tracks')
export class TracksController {
  constructor(private readonly tracks: TracksService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateTrack()
  create(
    @Body() dto: CreateTrackDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<TrackResponseDto> {
    return this.tracks.create(dto, { actorUserId: admin.id, correlationId });
  }

  @Get()
  @ApiListTracks()
  list(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<TrackResponseDto>> {
    return this.tracks.list(query);
  }
}
