import type { DbExecutor } from '../../infra/database/database.constants.js';
import { auditLog, type AuditAction, type AuditSubjectType } from './schema.js';

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
    correlationId: entry.correlationId ?? null,
  });
}
