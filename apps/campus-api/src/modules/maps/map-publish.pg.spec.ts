import { PinoLogger } from 'nestjs-pino';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import {
  REAL_POSTGRES_URL,
  unique,
} from '../../infra/database/testing/real-postgres.js';
import { SystemRole, users } from '../users/schema.js';
import { MapPublishService } from './map-publish.service.js';
import { maps } from './schema.js';
import { tellWorldMap } from './tell-world.js';
import { buildWorld } from '../../../../world/src/app.js';
import { loadEnv } from '../../../../world/src/infra/env.js';
import { emptySpaceIndex } from '../../../../world/src/movement/spaces.js';
import type { WorldMap } from '../../../../world/src/movement/world-map.js';

/**
 * The two services together, on a real PostgreSQL: the publish commits,
 * `pg_notify` reaches world's own listener connection, and world swaps in the
 * new geometry. PGlite cannot run this, because notifications only cross a
 * real connection.
 *
 * A database of its own is created for the test, so it neither sees rows other
 * tests leave behind nor takes the campus_test entry map away from them.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../infra/database/migrations', import.meta.url),
);

describe.skipIf(!REAL_POSTGRES_URL)(
  'a publish reaching a running world',
  () => {
    const name = `campus_world_${unique()}`;
    let admin: ReturnType<typeof postgres>;
    let client: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle>;
    let world: Awaited<ReturnType<typeof buildWorld>>;
    let oldMap: WorldMap;
    let newMap: WorldMap;

    beforeAll(async () => {
      admin = postgres(REAL_POSTGRES_URL as string, {
        max: 1,
        onnotice: () => undefined,
      });
      await admin.unsafe(`create database "${name}"`);
      const url = new URL(REAL_POSTGRES_URL as string);
      url.pathname = `/${name}`;
      client = postgres(url.toString(), {
        max: 5,
        onnotice: () => undefined,
      });
      db = drizzle(client);
      await migrate(db as never, { migrationsFolder: MIGRATIONS });

      const [user] = await db
        .insert(users)
        .values({
          email: `publish-${unique()}@campus.local`,
          systemRole: SystemRole.Admin,
        })
        .returning();
      const [map] = await db
        .insert(maps)
        .values({
          key: `campus-${unique()}`,
          name: 'Campus',
          isEntry: true,
        })
        .returning();

      const walls = new Uint8Array(5 * 5);
      oldMap = {
        id: map.key,
        version: 'old',
        grid: { width: 5, height: 5, spawn: { x: 0, y: 0 } },
        spaces: emptySpaceIndex(5, 5),
      };
      newMap = {
        id: map.key,
        version: 'new',
        grid: { width: 5, height: 5, spawn: { x: 0, y: 0 }, walls },
        spaces: emptySpaceIndex(5, 5),
      };
      walls[1] = 1;

      world = await buildWorld({
        env: loadEnv({
          AUTH_SESSION_SECRET: 'a-world-session-secret-of-at-least-32-chars',
          DEPLOYMENT_ENVIRONMENT: 'development',
          DATABASE_URL: url.toString(),
          FF_LOG_LEVEL: 'fatal',
        } as NodeJS.ProcessEnv),
        map: oldMap,
        loadMap: async () => newMap,
      });

      // world starts listening without holding the boot on it; give its
      // dedicated connection a moment to subscribe before publishing.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const service = new MapPublishService(db as never, tellWorldMap, {
        warn: () => undefined,
      } as unknown as PinoLogger);
      await service.publish(map.id, { actorUserId: user.id });
    }, 60_000);

    afterAll(async () => {
      await world?.gateway.stop();
      await world?.app.close();
      await world?.accounts.close();
      await client?.end();
      await admin?.unsafe(`drop database if exists "${name}" with (force)`);
      await admin?.end();
    }, 60_000);

    it('reloads the geometry after the publish notification commits', async () => {
      await vi.waitFor(() => expect(oldMap.grid).toBe(newMap.grid), {
        timeout: 10_000,
      });
      expect(oldMap.version).toBe('new');
      expect(oldMap.grid.walls?.[1]).toBe(1);
    });
  },
);
