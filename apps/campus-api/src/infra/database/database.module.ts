import { Global, Module } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { CONFIG, type Env } from '../config/config.module.js';
import { DRIZZLE } from './database.constants.js';
import * as schema from './schema/index.js';

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [CONFIG],
      useFactory: (config: Env): PostgresJsDatabase<typeof schema> => {
        const sql = postgres(config.DATABASE_URL);
        return drizzle(sql, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}