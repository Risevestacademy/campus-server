import { randomInt } from 'node:crypto';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export const ROOM_LINK_CODE_LENGTH = 10;

export const ROOM_LINK_CODE = new RegExp(
  `^[A-Za-z0-9]{${ROOM_LINK_CODE_LENGTH}}$`,
);

/** The page of the web app a room link opens. */
export const ROOM_LINK_PATH = '/join/';

export function generateRoomLinkCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_LINK_CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}
