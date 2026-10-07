import { Inject, Injectable } from '@nestjs/common';
import { isDateString } from 'class-validator';
import { eq } from 'drizzle-orm';

import { DRIZZLE, type Db } from '../../infra/database/database.constants.js';
import type { AuthenticatedUser } from '../../shared/auth/authenticated-user.js';
import { DomainException } from '../../shared/exceptions/domain.exception.js';
import { ExceptionCode } from '../../shared/exceptions/exception-code.enum.js';
import { CohortRole, cohorts, cohortTracks } from '../cohorts/schema.js';
import { tracks } from '../tracks/schema.js';
import type { CreateInviteDto } from './dto/create-invite.dto.js';
import {
  InviteImportOutcome,
  type InviteImportResponseDto,
  type InviteImportRowDto,
} from './dto/invite-import.dto.js';
import { parseInviteCsv, type InviteCsvRow } from './invite-csv.js';
import { InviteMailer } from './invite-mailer.js';
import { InviteNotFoundException } from './invites.exceptions.js';
import { InvitesService } from './invites.service.js';

/** How many invite emails are in flight at once. */
const EMAIL_CONCURRENCY = 5;

/**
 * Invites a cohort's intake from one file.
 *
 * Each row becomes an ordinary invite, made by the same InvitesService.create
 * a single invite goes through, so every rule that holds for one invite holds
 * for a row: one pending invite per address, no inviting somebody already in
 * the cohort, a student needs a track. A file adds nothing to those rules; it
 * only saves the admin typing them one at a time.
 *
 * Rows stand alone. One that fails is reported and the rest go ahead: an
 * intake of two hundred should not be refused for one mistyped address, and
 * the admin can fix that row and upload it again without re-inviting the
 * others, who are refused the second time as already invited.
 *
 * A fault is different: it invites nobody. Every row is written in one
 * transaction, so an import that breaks partway leaves no invites behind
 * whose links were never shown and whose emails were never sent, and the
 * same file can be uploaded again.
 */
@Injectable()
export class InviteImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly invites: InvitesService,
    private readonly mailer: InviteMailer,
  ) {}

  async import(
    cohortId: string,
    file: Buffer,
    inviter: AuthenticatedUser,
    correlationId?: string,
  ): Promise<InviteImportResponseDto> {
    // The file first: a file that cannot be read is the admin's to fix
    // whichever cohort it was meant for.
    const parsed = parseInviteCsv(file);
    const trackIds = await this.cohortTrackIds(cohortId);

    const results = new Map<number, InviteImportRowDto>();
    for (const error of parsed.errors) {
      results.set(error.line, {
        line: error.line,
        email: error.email,
        outcome: InviteImportOutcome.Failed,
        reason: error.reason,
      });
    }

    // One transaction for the file. Each row's write is a savepoint inside
    // it, so a refused row undoes only itself, while a fault undoes them
    // all: no invite is left pending with a link nobody was shown.
    const created = await this.db.transaction(async (tx) => {
      const created: { line: number; receipt: InviteReceipt }[] = [];
      // One at a time, in file order. Two rows for the same address then
      // resolve the same way every time: the first is invited and the
      // second is refused as a duplicate.
      for (const row of parsed.rows) {
        try {
          const receipt = await this.invites.create(
            this.toDto(cohortId, row, trackIds),
            inviter,
            correlationId,
            tx,
          );
          created.push({ line: row.line, receipt });
        } catch (err) {
          // A refusal is this row's answer. Anything else is a fault — an
          // unexpected error, or one of the service's own invariants
          // failing — and carrying on past it would report a broken import
          // as a partial one.
          if (
            !(err instanceof DomainException) ||
            err.code === ExceptionCode.InternalError
          ) {
            throw err;
          }
          results.set(row.line, {
            line: row.line,
            email: row.email,
            outcome: InviteImportOutcome.Failed,
            reason: err.message,
          });
        }
      }
      return created;
    });

    // Emails only once every write is committed, and a few at a time: sent
    // one by one, a full file would hold the request open for minutes.
    await inBatches(created, EMAIL_CONCURRENCY, async ({ line, receipt }) => {
      results.set(line, {
        line,
        email: receipt.email,
        outcome: InviteImportOutcome.Invited,
        inviteId: receipt.id,
        inviteLink: receipt.inviteLink,
        emailStatus: await this.mailer.send(receipt),
      });
    });

    const rows = [...results.values()].sort((a, b) => a.line - b.line);
    const invited = created.length;
    return {
      total: rows.length,
      invited,
      failed: rows.length - invited,
      rows,
    };
  }

  /** The cohort's tracks by code, as the `track` column names them. */
  private async cohortTrackIds(cohortId: string): Promise<Map<string, string>> {
    const [cohort] = await this.db
      .select({ id: cohorts.id })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId))
      .limit(1);
    if (!cohort) {
      throw new InviteNotFoundException(`Cohort ${cohortId} not found`, {
        cohortId,
      });
    }

    const rows = await this.db
      .select({ id: cohortTracks.id, code: tracks.code })
      .from(cohortTracks)
      .innerJoin(tracks, eq(tracks.id, cohortTracks.trackId))
      .where(eq(cohortTracks.cohortId, cohortId));
    return new Map(rows.map((row) => [row.code, row.id]));
  }

  private toDto(
    cohortId: string,
    row: InviteCsvRow,
    trackIds: Map<string, string>,
  ): CreateInviteDto {
    let cohortTrackId: string | undefined;
    if (row.track !== null) {
      cohortTrackId = trackIds.get(row.track);
      if (!cohortTrackId) {
        throw new RowRefused(
          `This cohort does not run a track with code ${row.track}`,
        );
      }
    } else if (row.role === CohortRole.Student) {
      throw new RowRefused('track is required for a student');
    }

    // The same rules create enforces, said here in the file's own words:
    // the admin is looking at a column called visit_ends, not at a field
    // called guestAccessExpiresAt.
    if (row.role === CohortRole.Guest) {
      if (row.visitEnds === null) {
        throw new RowRefused('visit_ends is required for a guest');
      }
      // The form the single-invite route asks for, and no other: Date.parse
      // alone would also take 12/31/2030, and read it by the server's locale.
      const ends = isDateString(row.visitEnds)
        ? Date.parse(row.visitEnds)
        : Number.NaN;
      if (Number.isNaN(ends)) {
        throw new RowRefused(
          'visit_ends is not a date: use a form like 2026-11-30T17:00:00Z',
        );
      }
      if (ends <= Date.now()) {
        throw new RowRefused('visit_ends must be in the future');
      }
    } else if (row.visitEnds !== null) {
      throw new RowRefused('visit_ends is only for a guest');
    }

    return {
      email: row.email,
      cohortId,
      cohortRole: row.role,
      cohortTrackId,
      guestAccessExpiresAt:
        row.visitEnds === null
          ? undefined
          : new Date(row.visitEnds).toISOString(),
    };
  }
}

type InviteReceipt = Awaited<ReturnType<InvitesService['create']>>;

/** A row the file itself rules out, before any invite is attempted. */
class RowRefused extends DomainException {
  readonly code = ExceptionCode.InvalidArgument;
}

/** Runs `task` over `items`, at most `size` at a time. */
async function inBatches<T>(
  items: readonly T[],
  size: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(task));
  }
}
