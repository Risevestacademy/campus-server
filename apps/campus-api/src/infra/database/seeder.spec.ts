import type { PinoLogger } from 'nestjs-pino';

import { SystemRole, UserStatus } from '../../modules/users/schema.js';
import type { Db } from './database.constants.js';
import type { Env } from '../config/env.js';
import { Seeder } from './seeder.js';

const EMAIL = 'admin@campus.local';

function makeConfig(email: string = EMAIL): Env {
  return { DEFAULT_ADMIN_EMAIL: email } as Env;
}

function makeLogger(): PinoLogger {
  return { info: vi.fn() } as unknown as PinoLogger;
}

function makeDb(existing?: { id: string; systemRole: SystemRole } | null) {
  const insertValues = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(existing ? [existing] : []),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({ set: updateSet }),
  };

  return {
    db: db as unknown as Db,
    insertValues,
    updateSet,
  };
}

describe('Seeder', () => {
  it('seeds an admin when no user with the email exists', async () => {
    const { db, insertValues } = makeDb(null);
    const seeder = new Seeder(db, makeConfig(), makeLogger());

    await seeder.run();

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith({
      email: EMAIL,
      systemRole: SystemRole.Admin,
      status: UserStatus.Active,
    });
  });

  it('does nothing when an admin with the email already exists', async () => {
    const { db, insertValues, updateSet } = makeDb({ id: 'user-1', systemRole: SystemRole.Admin });
    const seeder = new Seeder(db, makeConfig(), makeLogger());

    await seeder.run();

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('promotes an existing non-admin user to admin', async () => {
    const { db, insertValues, updateSet } = makeDb({ id: 'user-1', systemRole: SystemRole.User });
    const seeder = new Seeder(db, makeConfig(), makeLogger());

    await seeder.run();

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ systemRole: SystemRole.Admin });
  });

  it('runs on application bootstrap', async () => {
    const { db, insertValues } = makeDb(null);
    const seeder = new Seeder(db, makeConfig(), makeLogger());

    await seeder.onApplicationBootstrap();

    expect(insertValues).toHaveBeenCalledTimes(1);
  });
});