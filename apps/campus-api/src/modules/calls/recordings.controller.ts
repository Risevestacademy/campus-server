import {
  Controller,
  Delete,
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
import { ApiStartRecording, ApiStopRecording } from './docs/recordings.docs.js';
import { RecordingDto, RecordingSpaceParamDto } from './dto/recording.dto.js';
import { RecordingsService } from './recordings.service.js';

@ApiTags('recordings')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('cohorts/:cohortId/spaces/:spaceId/recording')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Post()
  @ApiStartRecording()
  async start(
    @Param() params: RecordingSpaceParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RecordingDto> {
    return RecordingDto.from(
      await this.recordings.start(
        user.id,
        params.cohortId,
        params.spaceId,
        new Date(),
      ),
    );
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiStopRecording()
  async stop(
    @Param() params: RecordingSpaceParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RecordingDto> {
    return RecordingDto.from(
      await this.recordings.stop(
        user.id,
        params.cohortId,
        params.spaceId,
        new Date(),
      ),
    );
  }
}
