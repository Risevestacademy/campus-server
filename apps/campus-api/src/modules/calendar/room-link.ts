import {
  ROOM_LINK_CODE,
  ROOM_LINK_PATH,
} from '../room-links/room-link-code.js';

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * The code of the first campus room link, `{APP_PUBLIC_URL}/join/{code}`, in
 * an event's location, else its description. Only the shape is checked here:
 * whether the link is live, and the member may open it, is the room-links
 * module's to say.
 */
export function extractRoomLinkCode(
  appUrl: string,
  location: string | null,
  description: string | null,
): string | null {
  const base = `${appUrl.replace(/\/+$/, '')}${ROOM_LINK_PATH}`;
  // Every run of letters and digits after the prefix, so `/join/abc` inside a
  // longer word or a code one character too long is not taken for a code.
  const link = new RegExp(`${base.replace(ESCAPE, '\\$&')}([A-Za-z0-9]+)`, 'g');
  for (const field of [location, description]) {
    for (const [, code] of field?.matchAll(link) ?? []) {
      if (ROOM_LINK_CODE.test(code)) {
        return code;
      }
    }
  }
  return null;
}
