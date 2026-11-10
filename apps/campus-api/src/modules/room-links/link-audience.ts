import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import type { Tx } from '../../infra/database/database.constants.js';
import { roomLinks } from './schema.js';

export type AudienceRelease =
  | { released: true; clearedLinkIds: string[] }
  | { released: false; liveLinkIds: string[] };

type AudienceColumn =
  typeof roomLinks.cohortTrackId | typeof roomLinks.mentorshipGroupId;

/**
 * Lets a track be detached or a pod deleted only once no live link is aimed
 * at it. Revoked links lose the pointer and keep the rest; their tallied
 * attendance does not depend on it. The caller holds the track's or group's
 * row for update, so no link can be aimed at it meanwhile.
 */
async function releaseAudience(
  tx: Tx,
  column: AudienceColumn,
  id: string,
): Promise<AudienceRelease> {
  const live = await tx
    .select({ id: roomLinks.id })
    .from(roomLinks)
    .where(and(eq(column, id), isNull(roomLinks.revokedAt)));
  if (live.length > 0) {
    return { released: false, liveLinkIds: live.map((l) => l.id) };
  }

  const cleared = await tx
    .update(roomLinks)
    .set(
      column === roomLinks.cohortTrackId
        ? { cohortTrackId: null }
        : { mentorshipGroupId: null },
    )
    .where(and(eq(column, id), isNotNull(roomLinks.revokedAt)))
    .returning({ id: roomLinks.id });
  return { released: true, clearedLinkIds: cleared.map((l) => l.id) };
}

export function releaseTrackLinks(
  tx: Tx,
  cohortTrackId: string,
): Promise<AudienceRelease> {
  return releaseAudience(tx, roomLinks.cohortTrackId, cohortTrackId);
}

export function releaseGroupLinks(
  tx: Tx,
  mentorshipGroupId: string,
): Promise<AudienceRelease> {
  return releaseAudience(tx, roomLinks.mentorshipGroupId, mentorshipGroupId);
}
