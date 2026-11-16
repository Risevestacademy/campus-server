import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Brings the real PostgreSQL up to the committed migrations, once, before
 * any test file runs. Here rather than in each file's beforeAll: the files
 * run side by side, and several of them migrating one database at the same
 * moment would trip over each other creating the same tables.
 *
 * Does nothing when CAMPUS_TEST_DATABASE_URL is unset, which is the usual
 * case locally; the tests that need it skip themselves.
 */
export default async function setup(): Promise<void> {
  const url = process.env.CAMPUS_TEST_DATABASE_URL;
  if (!url) {
    return;
  }
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(
        new URL('./src/infra/database/migrations', import.meta.url),
      ),
    });
  } finally {
    await client.end();
  }
}
