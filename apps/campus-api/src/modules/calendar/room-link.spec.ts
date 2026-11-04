import { extractRoomLinkCode } from './room-link.js';

const APP = 'https://campus.test';
const CODE = 'k3F9xQ2pLm';

it('takes the code from the location', () => {
  expect(extractRoomLinkCode(APP, `${APP}/join/${CODE}`, null)).toBe(CODE);
});

it('takes the code from the description', () => {
  expect(
    extractRoomLinkCode(APP, null, `Join us at ${APP}/join/${CODE} for class`),
  ).toBe(CODE);
});

it('prefers the location over the description', () => {
  expect(
    extractRoomLinkCode(APP, `${APP}/join/${CODE}`, `${APP}/join/Zz9Yy8Xx7W`),
  ).toBe(CODE);
});

it('falls through to the description when the location has no link', () => {
  expect(
    extractRoomLinkCode(APP, 'Room 5B, second floor', `${APP}/join/${CODE}`),
  ).toBe(CODE);
});

it('finds a link inside Google’s HTML description', () => {
  expect(
    extractRoomLinkCode(
      APP,
      null,
      `<a href="${APP}/join/${CODE}">${APP}/join/${CODE}</a>`,
    ),
  ).toBe(CODE);
});

it('takes a code followed by punctuation or a query', () => {
  expect(extractRoomLinkCode(APP, null, `(${APP}/join/${CODE}).`)).toBe(CODE);
  expect(extractRoomLinkCode(APP, null, `${APP}/join/${CODE}?x=1`)).toBe(CODE);
});

it('skips a malformed link for a good one later on', () => {
  expect(
    extractRoomLinkCode(
      APP,
      null,
      `${APP}/join/short then ${APP}/join/${CODE}`,
    ),
  ).toBe(CODE);
});

it('is null with no link, or only the old space links', () => {
  expect(extractRoomLinkCode(APP, null, null)).toBeNull();
  expect(extractRoomLinkCode(APP, 'Room 5B', 'Just a meeting')).toBeNull();
  expect(extractRoomLinkCode(APP, `${APP}/space/pod-a`, null)).toBeNull();
});

it('refuses a code of the wrong length', () => {
  expect(extractRoomLinkCode(APP, `${APP}/join/${CODE}X`, null)).toBeNull();
  expect(extractRoomLinkCode(APP, `${APP}/join/k3F9`, null)).toBeNull();
});

it('refuses another host', () => {
  expect(
    extractRoomLinkCode(APP, `https://elsewhere.test/join/${CODE}`, null),
  ).toBeNull();
  expect(
    extractRoomLinkCode(APP, `https://campusXtest/join/${CODE}`, null),
  ).toBeNull();
});

it('copes with a trailing slash on the app URL', () => {
  expect(extractRoomLinkCode(`${APP}/`, `${APP}/join/${CODE}`, null)).toBe(
    CODE,
  );
});
