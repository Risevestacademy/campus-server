import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import type { PaginatedResponseDto } from '../../shared/dto/index.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiGetFeedback,
  ApiListFeedback,
  ApiSendFeedback,
  ApiSetFeedbackStatus,
} from './docs/feedback.docs.js';
import {
  CreateFeedbackDto,
  FeedbackDto,
  FeedbackIdParamDto,
  type FeedbackListItemDto,
  FeedbackReceiptDto,
  ListFeedbackQueryDto,
  UpdateFeedbackStatusDto,
} from './dto/feedback.dto.js';
import { FeedbackNotifier } from './feedback-notifier.js';
import { FeedbackService } from './feedback.service.js';

/**
 * Sending is for any member with a full session; reading is for admins.
 * Nothing here lets a member read feedback, their own included: a report is
 * about somebody, and the fewer places it can be read from the better.
 */
@ApiTags('feedback')
@ApiBearerAuth()
// SessionGuard on every route; the admin ones add AdminGuard after it.
// Guards run left to right, so the order matters.
@UseGuards(SessionGuard)
@Controller('feedback')
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly notifier: FeedbackNotifier,
  ) {}

  @Post()
  @ApiSendFeedback()
  async send(
    @CurrentUser() author: AuthenticatedUser,
    @Body() dto: CreateFeedbackDto,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<FeedbackReceiptDto> {
    const receipt = await this.feedback.create(author, dto, userAgent);
    // After the write, and not waited for. The report is saved and in the
    // list whatever becomes of the email, and a member held up by a slow
    // mail provider sends it again. notify() never rejects.
    void this.notifier.notify({
      id: receipt.id,
      type: receipt.type,
      reportedUserId: dto.reportedUserId,
    });
    return receipt;
  }

  @Get()
  @UseGuards(AdminGuard)
  @ApiListFeedback()
  list(
    @CurrentUser() admin: AuthenticatedUser,
    @Query() query: ListFeedbackQueryDto,
  ): Promise<PaginatedResponseDto<FeedbackListItemDto>> {
    return this.feedback.list(admin, query);
  }

  @Get(':id')
  @UseGuards(AdminGuard)
  @ApiGetFeedback()
  get(
    @CurrentUser() admin: AuthenticatedUser,
    @Param() params: FeedbackIdParamDto,
  ): Promise<FeedbackDto> {
    return this.feedback.get(admin, params.id);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiSetFeedbackStatus()
  setStatus(
    @Param() params: FeedbackIdParamDto,
    @Body() dto: UpdateFeedbackStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<FeedbackDto> {
    return this.feedback.setStatus(admin, params.id, dto.status, correlationId);
  }
}
