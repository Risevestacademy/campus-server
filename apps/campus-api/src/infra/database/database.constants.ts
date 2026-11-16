import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import * as schema from './schema/index.js';

export const DRIZZLE = Symbol('DRIZZLE');

export type Db = PostgresJsDatabase<typeof schema>;

/** The transaction handle drizzle hands a `db.transaction` callback. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Either the pool or a transaction: anything a query can run on. */
export type DbExecutor = Db | Tx;
