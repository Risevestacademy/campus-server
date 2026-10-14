/**
 * The characters a member may pick to walk the campus as. Placeholders until
 * design delivers the real set; world sends the stored key on as it is, so
 * the clients' artwork has to carry a sprite for every key here.
 */
export const SPRITE_KEYS = [
  'placeholder-1',
  'placeholder-2',
  'placeholder-3',
  'placeholder-4',
] as const;

export type SpriteKey = (typeof SPRITE_KEYS)[number];
