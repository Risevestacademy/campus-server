import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { RecordingStatus, type CallRecording } from '../schema.js';

export class RecordingSpaceParamDto {
  /** @example 11111111-1111-4111-8111-111111111111 */
  @IsUUID()
  cohortId: string;

  /** @example 33333333-3333-4333-8333-333333333333 */
  @IsUUID()
  spaceId: string;
}

export class RecordingDto {
  /** @example 55555555-5555-4555-8555-555555555555 */
  id: string;

  /** The call it records. @example 66666666-6666-4666-8666-666666666666 */
  sessionId: string;

  @ApiProperty({ enum: RecordingStatus })
  status: RecordingStatus;

  /** @example 77777777-7777-4777-8777-777777777777 */
  startedBy: string;

  /** Null unless somebody stopped it before the call ended. */
  stoppedBy: string | null;

  /** @example 2026-11-12T10:00:00.000Z */
  requestedAt: Date;

  /** When LiveKit began recording; null until it has. */
  startedAt: Date | null;

  endedAt: Date | null;

  /** @example 3600000 */
  durationMs: number | null;

  static from(row: CallRecording): RecordingDto {
    return {
      id: row.id,
      sessionId: row.sessionId,
      status: row.status,
      startedBy: row.startedBy,
      stoppedBy: row.stoppedBy,
      requestedAt: row.requestedAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
    };
  }
}
