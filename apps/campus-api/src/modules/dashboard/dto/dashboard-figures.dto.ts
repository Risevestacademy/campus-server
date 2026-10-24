import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class DashboardFiguresQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description: 'One cohort’s figures. Left out, the whole campus.',
  })
  @IsOptional()
  @IsUUID()
  cohortId?: string;
}

export class MembersByRoleDto {
  @ApiProperty({ example: 30 })
  student!: number;

  @ApiProperty({ example: 2 })
  professor!: number;

  @ApiProperty({ example: 4 })
  mentor!: number;

  @ApiProperty({ example: 3 })
  guest!: number;
}

export class MemberFiguresDto {
  @ApiProperty({
    example: 38,
    description:
      'People with a live membership, suspended accounts included, as on ' +
      'the roster. Across the campus, somebody in two cohorts counts once.',
  })
  total!: number;

  @ApiProperty({
    type: MembersByRoleDto,
    description:
      'People with a live membership in each cohort role. Across the ' +
      'campus, somebody holding two roles counts under both, so these can ' +
      'add up to more than `total`.',
  })
  byRole!: MembersByRoleDto;
}

export class DashboardFiguresDto {
  @ApiProperty({ type: MemberFiguresDto })
  members!: MemberFiguresDto;

  @ApiProperty({
    example: 7,
    description:
      'Invites still waiting for an answer: pending and not yet expired. ' +
      'Across the campus this includes admin invites, which name no cohort.',
  })
  pendingInvites!: number;
}
