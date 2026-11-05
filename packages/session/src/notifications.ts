/**
 * The Redis channel a new notification is published on, once its row is
 * committed: by campus-api for the ones it writes, by world for its own.
 * Every world instance subscribes and pushes it to the recipient's sockets
 * it holds. Best effort: one that never arrives is still in the list.
 */
export const NOTIFICATION_CREATED_CHANNEL = 'notifications:created';

/** One message on that channel, as JSON: one recipient, one notification. */
export interface NotificationCreated {
  recipientId: string;
  /**
   * The cohort the event happened in, whose socket alone is told. Null for
   * one that belongs to no cohort, a campus-wide notice, which goes to every
   * socket the recipient holds.
   */
  cohortId: string | null;
  /** The notification's own id, as the list answers it. */
  id: string;
  kind: string;
  referenceType: string;
  referenceId: string;
  /** ISO 8601. */
  createdAt: string;
}
