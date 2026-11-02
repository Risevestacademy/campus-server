import { resolveCorrelationId } from './correlation-id.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it('keeps a UUID the caller sent', () => {
    const id = '0b9d3c4e-8f2a-4c1d-9e7b-5a6f3d2c1b0a';

    expect(resolveCorrelationId(id)).toBe(id);
  });

  it.each([
    ['an email', 'ada@example.com'],
    ['a name', 'Ada_Lovelace'],
    ['a phone number', '08012345678'],
    ['a slug', 'req-123'],
    ['too long', 'c'.repeat(200)],
  ])('replaces one that is %s', (_label, incoming) => {
    const id = resolveCorrelationId(incoming);

    expect(id).toMatch(UUID);
    expect(id).not.toBe(incoming);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    // Node hands a header sent twice over as an array.
    ['sent twice', ['a', 'b']],
  ])('generates one when the header is %s', (_label, incoming) => {
    expect(resolveCorrelationId(incoming)).toMatch(UUID);
  });
});
