import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiReadMedia } from './docs/uploads.docs.js';
import { MediaIdParamDto, SignedReadDto } from './dto/upload.dto.js';
import { MediaService } from './media.service.js';

@ApiTags('uploads')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':id/url')
  @ApiReadMedia()
  url(
    @CurrentUser() viewer: AuthenticatedUser,
    @Param() params: MediaIdParamDto,
  ): Promise<SignedReadDto> {
    return this.media.readUrl(viewer, params.id, new Date());
  }
}
