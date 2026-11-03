import { extractSpaceKey } from './space-link.js';

const APP = 'https://campus.example.com';

it('extracts the space key from the location', () => {
  expect(extractSpaceKey(APP, `${APP}/space/meeting-room-1`, null, null)).toBe(
    'meeting-room-1',
  );
});

it('extracts the space key from the meeting URL', () => {
  expect(extractSpaceKey(APP, null, `${APP}/space/pod-a`, null)).toBe('pod-a');
});

it('extracts the space key from the description', () => {
  expect(
    extractSpaceKey(
      APP,
      null,
      null,
      `Join us at ${APP}/space/classroom-b for the session`,
    ),
  ).toBe('classroom-b');
});

it('prefers location over meetingUrl and description', () => {
  expect(
    extractSpaceKey(
      APP,
      `${APP}/space/from-location`,
      `${APP}/space/from-url`,
      `${APP}/space/from-desc`,
    ),
  ).toBe('from-location');
});

it('falls through when location has no match', () => {
  expect(
    extractSpaceKey(
      APP,
      'Room 5B, second floor',
      `${APP}/space/from-url`,
      null,
    ),
  ).toBe('from-url');
});

it('returns null when no field matches', () => {
  expect(
    extractSpaceKey(
      APP,
      'Room 5B',
      'https://meet.google.com/abc',
      'Just a meeting',
    ),
  ).toBeNull();
});

it('returns null for all-null fields', () => {
  expect(extractSpaceKey(APP, null, null, null)).toBeNull();
});

it('handles an app URL with a trailing slash', () => {
  expect(
    extractSpaceKey(
      'https://campus.example.com/',
      `https://campus.example.com/space/pod`,
      null,
      null,
    ),
  ).toBe('pod');
});

it('rejects a key longer than 64 characters', () => {
  const longKey = 'a'.repeat(65);
  expect(
    extractSpaceKey(APP, `${APP}/space/${longKey}`, null, null),
  ).toBeNull();
});

it('accepts underscores and hyphens in keys', () => {
  expect(extractSpaceKey(APP, `${APP}/space/my_room-2`, null, null)).toBe(
    'my_room-2',
  );
});

it('does not match a different host', () => {
  expect(
    extractSpaceKey(APP, 'https://evil.com/space/room', null, null),
  ).toBeNull();
});

it('extracts a key from a URL followed by punctuation', () => {
  expect(
    extractSpaceKey(APP, null, null, `Meet here: ${APP}/space/pod-a.`),
  ).toBe('pod-a');
});

it('extracts a key inside parentheses', () => {
  expect(extractSpaceKey(APP, null, null, `(${APP}/space/studio)`)).toBe(
    'studio',
  );
});
