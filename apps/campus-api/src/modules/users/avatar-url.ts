import { sql, type SQL } from 'drizzle-orm';

import { media } from '../media/schema.js';
import { users } from './schema.js';

/**
 * The picture a person shows, for a query over `users`: the one they
 * uploaded, else the one Google gave them, else null for initials. Built
 * from the file's key so moving the files means changing `publicUrl` only.
 */
export function avatarUrl(publicUrl: string | undefined): SQL<string | null> {
  if (!publicUrl) return sql<string | null>`${users.googlePictureUrl}`;
  const key = sql`(select ${media.key} from ${media} where ${media.id} = ${users.avatarMediaId})`;
  return sql<
    string | null
  >`coalesce(${publicUrl} || '/' || ${key}, ${users.googlePictureUrl})`;
}
