import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';

import { SystemRole } from '../schema.js';

/** The roles an admin may hand out or take back. Never super admin. */
export const ASSIGNABLE_SYSTEM_ROLES = [SystemRole.User, SystemRole.Admin];

/** The `:id` of the routes that act on one user. */
export class UserIdParamDto {
  @ApiProperty({ example: '22222222-2222-4222-8222-222222222222' })
  @IsUUID()
  id: string;
}

export class SetSystemRoleDto {
  @ApiProperty({
    enum: ASSIGNABLE_SYSTEM_ROLES,
    example: SystemRole.Admin,
    description:
      '`admin` to grant the admin role, `user` to revoke it. `super_admin` ' +
      'is not accepted: only the seed grants it.',
  })
  @IsIn(ASSIGNABLE_SYSTEM_ROLES, {
    message: `systemRole must be one of: ${ASSIGNABLE_SYSTEM_ROLES.join(', ')}`,
  })
  systemRole: SystemRole.User | SystemRole.Admin;
}

/** The account after the change, as much as the caller needs to redraw a row. */
export class UserSystemRoleDto {
  @ApiProperty({ example: '22222222-2222-4222-8222-222222222222' })
  id: string;

  @ApiProperty({ example: 'ada@campus.local' })
  email: string;

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole' })
  systemRole: SystemRole;
}
