import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiCreateUpload, ApiUploadLimits } from './docs/uploads.docs.js';
import {
  CreateUploadDto,
  UploadDto,
  UploadLimitsDto,
} from './dto/upload.dto.js';
import { MEDIA_RULES } from './media-rules.js';
import { MediaService } from './media.service.js';
import type { MediaKind } from './schema.js';

@ApiTags('uploads')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiCreateUpload()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateUploadDto,
  ): Promise<UploadDto> {
    const upload = await this.media.createUpload(user.id, dto, new Date());
    return { ...upload, method: 'PUT' };
  }

  @Get('limits')
  @ApiUploadLimits()
  limits(): UploadLimitsDto {
    return {
      kinds: Object.entries(MEDIA_RULES).map(([kind, rule]) => ({
        kind: kind as MediaKind,
        contentTypes: [...rule.contentTypes],
        maxBytes: rule.maxBytes,
      })),
    };
  }
}
