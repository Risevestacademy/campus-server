import { InviteInvalidArgumentException } from './invites.exceptions.js';

export const INVALID_DATE_MESSAGE = 'is not a valid date';

/**
 * Reads a date the request layer has already accepted as ISO 8601. It only
 * decides whether the value is readable; being in the future and every other
 * rule about a readable date stay with the caller.
 */
export function parseInviteDate(value: string, field: string): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new InviteInvalidArgumentException(
      `${field} ${INVALID_DATE_MESSAGE}`,
      { field },
    );
  }
  return at;
}
