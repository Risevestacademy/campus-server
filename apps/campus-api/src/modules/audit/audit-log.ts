import type { DbExecutor } from '../../infra/database/database.constants.js';
import {
  CORRELATION_ID_MAX_LENGTH,
  auditLog,
  type AuditAction,
  type AuditSubjectType,
} from './schema.js';

/** Who did it and which request — the parts every entry from one call shares. */
export interface AuditContext {
  actorUserId: string | null;
  correlationId?: string;
}

export interface AuditEntry extends AuditContext {
  action: AuditAction;
  subject?: { type: AuditSubjectType; id: string };
  details?: Record<string, unknown>;
}

export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

/**
 * The listed fields whose value differs between the row before an edit and
 * after it, each with both values — what an update entry records, rather than
 * the request body, which may name fields it left as they were.
 */
export function changedFields<T extends object>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): FieldChanges {
  const changes: FieldChanges = {};
  for (const field of fields) {
    if (!Object.is(before[field], after[field])) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
}

/**
 * Appends one entry. Takes the caller's transaction rather than the pool on
 * purpose: the entry commits or rolls back with the change it describes, so
 * the log can never claim something that did not happen, nor miss something
 * that did.
 */
export async function writeAuditEntry(
  executor: DbExecutor,
  entry: AuditEntry,
): Promise<void> {
  await executor.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    subjectType: entry.subject?.type ?? null,
    subjectId: entry.subject?.id ?? null,
    details: entry.details ?? null,
    // The id is whatever the caller sent in x-correlation-id. One too long
    // for the column would fail this insert and, sharing its transaction,
    // undo the change being recorded — so it is cut to fit instead. The
    // start of it still finds the request's log lines.
    correlationId:
      entry.correlationId?.slice(0, CORRELATION_ID_MAX_LENGTH) ?? null,
  });
}
