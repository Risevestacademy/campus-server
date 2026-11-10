import type { NotificationCreated } from '@campus/session';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  NOTIFICATION_PUBLISHER,
  type NotificationPublisher,
} from './notification-publisher.js';

/**
 * Tells world about notifications just written, so it can push them to the
 * recipients' open sockets.
 *
 * Only once the rows are committed: a push for a rolled-back row would name
 * a notification the list never has. Never rejects, and the caller does not
 * wait on it: the rows are what count, and a missed push costs a badge that
 * shows on the next fetch instead.
 */
@Injectable()
export class NotificationPush {
  constructor(
    @Inject(NOTIFICATION_PUBLISHER)
    private readonly publisher: NotificationPublisher,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationPush.name);
  }

  async send(created: readonly NotificationCreated[]): Promise<void> {
    try {
      await this.publisher.publish(created);
    } catch (err) {
      // Counts and ids, never what the notice said.
      this.logger.warn(
        {
          err,
          count: created.length,
          referenceId: created[0]?.referenceId,
        },
        'notifications written but not pushed',
      );
    }
  }
}
