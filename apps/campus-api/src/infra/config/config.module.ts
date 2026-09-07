import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CONFIG } from './config.constants.js';
import { Env, loadEnv } from './env.js';

export { CONFIG, type Env };

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>): Env => loadEnv(config),
    }),
  ],
  providers: [
    {
      provide: CONFIG,
      useFactory: (): Env => loadEnv(),
    },
  ],
  exports: [CONFIG],
})
export class AppConfigModule {}