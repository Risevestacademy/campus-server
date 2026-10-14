import { describe, expect, it } from 'vitest';

import { SPRITE_KEYS, spriteKeyOrNone } from './profile.js';

describe('spriteKeyOrNone', () => {
  it.each(SPRITE_KEYS)('keeps %s, which is on the list', (key) => {
    expect(spriteKeyOrNone(key)).toBe(key);
  });

  // A key retired when the list changes, or one written by hand: drawn as
  // the default rather than sent on for clients to guess at.
  it.each(['retired-knight', '', 'PLACEHOLDER-1'])(
    'reads %j, which is not on the list, as none',
    (stored) => {
      expect(spriteKeyOrNone(stored)).toBeNull();
    },
  );

  it('reads nothing stored as none', () => {
    expect(spriteKeyOrNone(null)).toBeNull();
  });
});
