import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { CONFIG } from '../config/config.constants.js';
import type { Env } from '../config/env.js';
import { DRIZZLE, type Db } from './database.constants.js';
import * as schema from './schema/index.js';

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [CONFIG],
      useFactory: (config: Env): Db => {
        const sql = postgres(config.DATABASE_URL);
        return drizzle(sql, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}