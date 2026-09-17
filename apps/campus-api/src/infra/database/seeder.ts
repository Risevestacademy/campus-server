import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CONFIG } from '../config/config.constants.js';
import type { Env } from '../config/env.js';
import { DRIZZLE, type Db } from './database.constants.js';
import * as schema from './schema/index.js';
import { SystemRole, UserStatus } from '../../modules/users/schema.js';

@Injectable()
export class Seeder implements OnApplicationBootstrap {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Env,
    @InjectPinoLogger(Seeder.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  async run(): Promise<void> {
    await this.seedAdmins();
  }

  async seedAdmins(): Promise<void> {
    const email = this.config.DEFAULT_ADMIN_EMAIL;

    const [existing] = await this.db
      .select({ id: schema.users.id, systemRole: schema.users.systemRole })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (existing) {
      if (existing.systemRole !== SystemRole.Admin) {
        await this.db
          .update(schema.users)
          .set({ systemRole: SystemRole.Admin })
          .where(eq(schema.users.id, existing.id));
        this.logger.info({ email }, 'promoted existing user to admin');
      }
      return;
    }

    await this.db.insert(schema.users).values({
      email,
      systemRole: SystemRole.Admin,
      status: UserStatus.Active,
    });
    this.logger.info({ email }, 'seeded admin user');
  }
}