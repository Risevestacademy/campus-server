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
        // Idle connections are closed rather than held: an open one sends
        // keepalives for as long as it lives, which is traffic enough to
        // stop a serverless deployment ever going to sleep. The next query
        // reconnects on its own.
        const sql = postgres(config.DATABASE_URL, { idle_timeout: 20 });
        return drizzle(sql, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
