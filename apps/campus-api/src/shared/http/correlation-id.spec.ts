import {
  CORRELATION_ID_MAX_LENGTH,
  resolveCorrelationId,
} from './correlation-id.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it('keeps the id the caller sent', () => {
    expect(resolveCorrelationId('req-123')).toBe('req-123');
  });

  it('keeps one exactly as long as the limit', () => {
    const id = 'c'.repeat(CORRELATION_ID_MAX_LENGTH);

    expect(resolveCorrelationId(id)).toBe(id);
  });

  // Replaced, not cut: the start of somebody's id is an id nobody has.
  it('replaces one that is too long', () => {
    const id = 'c'.repeat(CORRELATION_ID_MAX_LENGTH + 1);

    expect(resolveCorrelationId(id)).toMatch(UUID);
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
