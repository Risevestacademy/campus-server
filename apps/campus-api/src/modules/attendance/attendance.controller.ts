import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { CurrentUser } from '../../shared/auth/current-user.decorator.js';
import type { PaginatedResponseDto } from '../../shared/dto/paginated-response.dto.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { AttendanceService } from './attendance.service.js';
import {
  ApiCorrectAttendance,
  ApiGetAttendanceClass,
  ApiGetStudentAttendance,
  ApiListAttendanceClasses,
  ApiListStudentAttendance,
} from './docs/attendance.docs.js';
import {
  AttendanceClassDetailDto,
  AttendanceClassDto,
  AttendanceClassParamDto,
  AttendanceCohortParamDto,
  AttendanceIdParamDto,
  AttendanceRowDto,
  AttendanceStudentParamDto,
  CorrectAttendanceDto,
  ListAttendanceClassesQueryDto,
  StudentAttendanceDto,
  StudentAttendanceSummaryDto,
} from './dto/attendance.dto.js';

@ApiTags('attendance')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('cohorts/:cohortId/attendance')
export class CohortAttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('classes')
  @ApiListAttendanceClasses()
  listClasses(
    @Param() params: AttendanceCohortParamDto,
    @Query() query: ListAttendanceClassesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResponseDto<AttendanceClassDto>> {
    return this.attendance.listClasses(user, params.cohortId, query);
  }

  @Get('students')
  @ApiListStudentAttendance()
  listStudents(
    @Param() params: AttendanceCohortParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StudentAttendanceSummaryDto[]> {
    return this.attendance.listStudents(user, params.cohortId);
  }

  @Get('students/:userId')
  @ApiGetStudentAttendance()
  getStudent(
    @Param() params: AttendanceStudentParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StudentAttendanceDto> {
    return this.attendance.getStudent(user, params.cohortId, params.userId);
  }
}

@ApiTags('attendance')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('classes/:instanceId')
  @ApiGetAttendanceClass()
  getClass(
    @Param() params: AttendanceClassParamDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceClassDetailDto> {
    return this.attendance.getClass(user, params.instanceId);
  }

  @Put(':attendanceId')
  @ApiCorrectAttendance()
  correct(
    @Param() params: AttendanceIdParamDto,
    @Body() body: CorrectAttendanceDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<AttendanceRowDto> {
    return this.attendance.correct(user, params.attendanceId, body, {
      actorUserId: user.id,
      correlationId,
    });
  }
}
