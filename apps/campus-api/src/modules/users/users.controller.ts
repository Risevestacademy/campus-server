import {
  Body,
  Controller,
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
import type { PaginatedResponseDto } from '../../shared/dto/index.js';
import { CorrelationId } from '../../shared/http/correlation-id.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ApiListUsers,
  ApiReinstateUser,
  ApiSetSystemRole,
  ApiSuspendUser,
} from './docs/users.docs.js';
import { ListUsersQueryDto } from './dto/list-users.dto.js';
import {
  SetSystemRoleDto,
  UserIdParamDto,
  UserSystemRoleDto,
} from './dto/system-role.dto.js';
import type { UserListItemDto } from './dto/user-list-item.dto.js';
import { SuspendUserDto, UserStatusDto } from './dto/user-status.dto.js';
import { UserRolesService } from './user-roles.service.js';
import { UserDirectoryService } from './user-directory.service.js';
import { UserStatusService } from './user-status.service.js';

@ApiTags('users')
@ApiBearerAuth()
// SessionGuard authenticates and sets req.user; AdminGuard reads it. Guards
// run left to right, so the order matters.
@UseGuards(SessionGuard, AdminGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly directory: UserDirectoryService,
    private readonly roles: UserRolesService,
    private readonly status: UserStatusService,
  ) {}

  @Get()
  @ApiListUsers()
  list(
    @Query() query: ListUsersQueryDto,
  ): Promise<PaginatedResponseDto<UserListItemDto>> {
    return this.directory.list(query);
  }

  @Patch(':id/system-role')
  @ApiSetSystemRole()
  setSystemRole(
    @Param() params: UserIdParamDto,
    @Body() dto: SetSystemRoleDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<UserSystemRoleDto> {
    return this.roles.setSystemRole(
      admin,
      params.id,
      dto.systemRole,
      correlationId,
    );
  }

  @Post(':id/suspend')
  // 200, not POST's default 201: the route answers with the row it changed.
  @HttpCode(HttpStatus.OK)
  @ApiSuspendUser()
  suspend(
    @Param() params: UserIdParamDto,
    @Body() dto: SuspendUserDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<UserStatusDto> {
    return this.status.suspend(admin, params.id, dto.reason, correlationId);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @ApiReinstateUser()
  reinstate(
    @Param() params: UserIdParamDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<UserStatusDto> {
    return this.status.reinstate(admin, params.id, correlationId);
  }
}
