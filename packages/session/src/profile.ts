/**
 * What both services read off a profile to draw somebody on the campus.
 * campus-api lets a member pick a sprite and tells world when they change
 * it; world sends it to everybody in their cohort. Defined once, so the two
 * cannot disagree about which keys exist or where a change is announced.
 */

/**
 * The characters a member may pick to walk the campus as. Placeholders until
 * design delivers the real set; the clients' artwork has to carry a sprite
 * for every key here.
 *
 * Swapping the list needs no clean-up of what is stored: a key that is no
 * longer here reads as no sprite at all (see `spriteKeyOrNone`), in
 * campus-api's answers and in what world sends, and clients draw their
 * default for it.
 */
export const SPRITE_KEYS = [
  'placeholder-1',
  'placeholder-2',
  'placeholder-3',
  'placeholder-4',
] as const;

export type SpriteKey = (typeof SPRITE_KEYS)[number];

const KNOWN: ReadonlySet<string> = new Set(SPRITE_KEYS);

/** The stored key if it is still on the list, and null if not. */
export function spriteKeyOrNone(stored: string | null): SpriteKey | null {
  return stored !== null && KNOWN.has(stored) ? (stored as SpriteKey) : null;
}

/**
 * The Postgres channel campus-api notifies, with the account id as the
 * payload, when somebody changes what others see of them: their sprite or
 * their display name. world listens, re-reads the account, and tells their
 * cohort straight away.
 */
export const PROFILE_CHANGED_CHANNEL = 'profile_changed';
