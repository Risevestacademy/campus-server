import { describe, expect, it } from 'vitest';

import { r2Connection } from './r2.js';

describe('r2Connection', () => {
  it('reaches the account’s S3 endpoint with path-style bucket names', () => {
    expect(r2Connection('acc123')).toEqual({
      region: 'auto',
      endpoint: 'https://acc123.r2.cloudflarestorage.com',
      forcePathStyle: true,
    });
  });
});
