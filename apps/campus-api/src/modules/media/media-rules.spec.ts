import { contentMatches } from './media-rules.js';

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const WAV = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45];

describe('contentMatches', () => {
  it.each([
    ['image/jpeg', JPEG],
    ['image/png', PNG],
    ['image/webp', WEBP],
  ])('knows a %s by its first bytes', (type, bytes) => {
    expect(contentMatches(type, Uint8Array.from(bytes))).toBe(true);
  });

  it.each([
    ['image/png', JPEG],
    ['image/jpeg', PNG],
    ['image/webp', WAV],
    ['image/png', PNG.slice(0, 4)],
    ['image/gif', PNG],
  ])('refuses a %s that is not one', (type, bytes) => {
    expect(contentMatches(type, Uint8Array.from(bytes))).toBe(false);
  });
});
