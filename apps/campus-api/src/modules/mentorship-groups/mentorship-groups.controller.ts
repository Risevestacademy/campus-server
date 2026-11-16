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
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import {
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../../shared/dto/index.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiAddMentorshipGroupStudent,
  ApiChangeMentorshipGroupMentor,
  ApiCreateMentorshipGroup,
  ApiDeleteMentorshipGroup,
  ApiGetMentorshipGroup,
  ApiListMentorshipGroups,
  ApiRemoveMentorshipGroupStudent,
  ApiUpdateMentorshipGroup,
} from './docs/mentorship-groups.docs.js';
import { AddStudentDto } from './dto/add-student.dto.js';
import { ChangeMentorDto } from './dto/change-mentor.dto.js';
import { CreateMentorshipGroupDto } from './dto/create-mentorship-group.dto.js';
import {
  MentorshipGroupCohortParamDto,
  MentorshipGroupParamDto,
  MentorshipGroupStudentParamDto,
} from './dto/mentorship-group-params.dto.js';
import { MentorshipGroupResponseDto } from './dto/mentorship-group-response.dto.js';
import { UpdateMentorshipGroupDto } from './dto/update-mentorship-group.dto.js';
import { MentorshipGroupsService } from './mentorship-groups.service.js';

@ApiTags('mentorship-groups')
@ApiBearerAuth()
@UseGuards(SessionGuard, AdminGuard)
@Controller('cohorts/:cohortId/mentorship-groups')
export class MentorshipGroupsController {
  constructor(private readonly groups: MentorshipGroupsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateMentorshipGroup()
  create(
    @Param() params: MentorshipGroupCohortParamDto,
    @Body() dto: CreateMentorshipGroupDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<MentorshipGroupResponseDto> {
    return this.groups.create(params.cohortId, dto, {
      actorUserId: admin.id,
      correlationId,
    });
  }

  @Get()
  @ApiListMentorshipGroups()
  list(
    @Param() params: MentorshipGroupCohortParamDto,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<MentorshipGroupResponseDto>> {
    return this.groups.list(params.cohortId, query);
  }

  @Get(':groupId')
  @ApiGetMentorshipGroup()
  get(
    @Param() params: MentorshipGroupParamDto,
  ): Promise<MentorshipGroupResponseDto> {
    return this.groups.get(params.cohortId, params.groupId);
  }

  @Patch(':groupId')
  @ApiUpdateMentorshipGroup()
  update(
    @Param() params: MentorshipGroupParamDto,
    @Body() dto: UpdateMentorshipGroupDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<MentorshipGroupResponseDto> {
    return this.groups.update(params.cohortId, params.groupId, dto, {
      actorUserId: admin.id,
      correlationId,
    });
  }

  @Patch(':groupId/mentor')
  @ApiChangeMentorshipGroupMentor()
  changeMentor(
    @Param() params: MentorshipGroupParamDto,
    @Body() dto: ChangeMentorDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<MentorshipGroupResponseDto> {
    return this.groups.changeMentor(params.cohortId, params.groupId, dto, {
      actorUserId: admin.id,
      correlationId,
    });
  }

  @Post(':groupId/students')
  @HttpCode(HttpStatus.CREATED)
  @ApiAddMentorshipGroupStudent()
  addStudent(
    @Param() params: MentorshipGroupParamDto,
    @Body() dto: AddStudentDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<MentorshipGroupResponseDto> {
    return this.groups.addStudent(
      params.cohortId,
      params.groupId,
      dto.cohortMemberId,
      { actorUserId: admin.id, correlationId },
    );
  }

  @Delete(':groupId/students/:cohortMemberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiRemoveMentorshipGroupStudent()
  removeStudent(
    @Param() params: MentorshipGroupStudentParamDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<void> {
    return this.groups.removeStudent(
      params.cohortId,
      params.groupId,
      params.cohortMemberId,
      { actorUserId: admin.id, correlationId },
    );
  }

  @Delete(':groupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDeleteMentorshipGroup()
  remove(
    @Param() params: MentorshipGroupParamDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<void> {
    return this.groups.remove(params.cohortId, params.groupId, {
      actorUserId: admin.id,
      correlationId,
    });
  }
}
