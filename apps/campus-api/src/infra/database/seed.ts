import 'reflect-metadata';

import { drizzle } from 'drizzle-orm/postgres-js';
import pino from 'pino';
import postgres from 'postgres';

import { loadEnv } from '../config/env.js';
import * as schema from './schema/index.js';
import { seedAdmin } from './seeder.js';

// `node dist/...` runs outside Nest, so nothing loads `.env` for us
// (ConfigModule does that at runtime; drizzle-kit does it for migrations).
// Node 20.6+ can do it natively — no extra dependency needed.
try {
  process.loadEnvFile();
} catch {
  // No .env file — env vars are expected to be provided externally.
}

async function main(): Promise<void> {
  const config = loadEnv();
  const logger = pino({ level: config.FF_LOG_LEVEL, name: 'db:seed' });

  if (!config.DEFAULT_ADMIN_EMAIL) {
    throw new Error(
      'DEFAULT_ADMIN_EMAIL is not set — it is required to seed the default admin user.',
    );
  }

  const sql = postgres(config.DATABASE_URL, { max: 1 });
  try {
    const db = drizzle(sql, { schema });
    await seedAdmin(db, config.DEFAULT_ADMIN_EMAIL, logger);
  } finally {
    await sql.end();
  }
}

await main();
