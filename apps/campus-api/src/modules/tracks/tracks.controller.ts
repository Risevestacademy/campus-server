import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiCreateTrack,
  ApiDeleteTrack,
  ApiListTracks,
  ApiUpdateTrack,
} from './docs/tracks.docs.js';
import { CreateTrackDto } from './dto/create-track.dto.js';
import { TrackIdParamDto, UpdateTrackDto } from './dto/update-track.dto.js';
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
  create(@Body() dto: CreateTrackDto): Promise<TrackResponseDto> {
    return this.tracks.create(dto);
  }

  @Get()
  @ApiListTracks()
  list(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<TrackResponseDto>> {
    return this.tracks.list(query);
  }

  @Patch(':id')
  @ApiUpdateTrack()
  update(
    @Param() params: TrackIdParamDto,
    @Body() dto: UpdateTrackDto,
  ): Promise<TrackResponseDto> {
    return this.tracks.update(params.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDeleteTrack()
  remove(@Param() params: TrackIdParamDto): Promise<void> {
    return this.tracks.remove(params.id);
  }
}
