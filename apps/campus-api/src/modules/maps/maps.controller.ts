import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiSyncMaps } from './docs/maps.docs.js';
import { MapSyncQueryDto, MapSyncResultDto } from './dto/map-sync.dto.js';
import { MapSyncService } from './map-sync.service.js';

@ApiTags('maps')
@ApiBearerAuth()
// SessionGuard authenticates and sets req.user; AdminGuard reads it. Guards
// run left to right, so the order matters.
@UseGuards(SessionGuard, AdminGuard)
@Controller('maps')
export class MapsController {
  constructor(private readonly mapSync: MapSyncService) {}

  @Post('sync')
  // 200, not POST's default 201: it answers with what it changed, and on
  // most calls that is nothing.
  @HttpCode(HttpStatus.OK)
  // Each call reads every published map from another service. Nobody needs
  // to do that more than a few times a minute.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiSyncMaps()
  sync(
    @Query() query: MapSyncQueryDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<MapSyncResultDto> {
    return this.mapSync.sync(admin, { dryRun: query.dryRun, correlationId });
  }
}
