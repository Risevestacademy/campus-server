import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import * as schema from './schema/index.js';

export const DRIZZLE = Symbol('DRIZZLE');

export type Db = PostgresJsDatabase<typeof schema>;