import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { CONFIG, type Env } from '../config/config.module.js';
import { DRIZZLE, type Db } from './database.constants.js';
import * as schema from './schema/index.js';
import { Seeder } from './seeder.js';

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
    Seeder,
  ],
  exports: [DRIZZLE, Seeder],
})
export class DatabaseModule {}