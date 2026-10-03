import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import type { PaginatedResponseDto } from '../../shared/dto/index.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiListUsers } from './docs/users.docs.js';
import { ListUsersQueryDto } from './dto/list-users.dto.js';
import type { UserListItemDto } from './dto/user-list-item.dto.js';
import { UserDirectoryService } from './user-directory.service.js';

@ApiTags('users')
@ApiBearerAuth()
// SessionGuard authenticates and sets req.user; AdminGuard reads it. Guards
// run left to right, so the order matters.
@UseGuards(SessionGuard, AdminGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly directory: UserDirectoryService) {}

  @Get()
  @ApiListUsers()
  list(
    @Query() query: ListUsersQueryDto,
  ): Promise<PaginatedResponseDto<UserListItemDto>> {
    return this.directory.list(query);
  }
}
