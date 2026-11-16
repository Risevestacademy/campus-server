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

describe('a link written another way', () => {
  const SITE = 'https://campusbyrise.com';

  it.each([
    `https://campusbyrise.com/join/${CODE}`,
    `http://campusbyrise.com/join/${CODE}`,
    `https://www.campusbyrise.com/join/${CODE}`,
    `https://CampusByRise.com/join/${CODE}`,
    `https://campusbyrise.com/%6Aoin/${CODE}`,
    `HTTPS://campusbyrise.com/join/${CODE}`,
  ])('takes the code from %s', (link) => {
    expect(extractRoomLinkCode(SITE, null, `Class at ${link} today`)).toBe(
      CODE,
    );
  });

  it('matches www. on the app URL against a link without it', () => {
    expect(
      extractRoomLinkCode(
        'https://www.campusbyrise.com',
        `https://campusbyrise.com/join/${CODE}`,
        null,
      ),
    ).toBe(CODE);
  });

  it('keeps the code case-sensitive', () => {
    expect(
      extractRoomLinkCode(
        SITE,
        null,
        `https://campusbyrise.com/join/${CODE.toUpperCase()}`,
      ),
    ).toBe(CODE.toUpperCase());
    expect(
      extractRoomLinkCode(
        SITE,
        null,
        `https://campusbyrise.com/join/${CODE.toLowerCase()}`,
      ),
    ).toBe(CODE.toLowerCase());
  });

  it('refuses another port, or a host that only ends the same', () => {
    expect(
      extractRoomLinkCode(
        SITE,
        `https://campusbyrise.com:8443/join/${CODE}`,
        null,
      ),
    ).toBeNull();
    expect(
      extractRoomLinkCode(
        SITE,
        `https://evilcampusbyrise.com/join/${CODE}`,
        null,
      ),
    ).toBeNull();
    expect(
      extractRoomLinkCode(
        SITE,
        `https://campusbyrise.com.evil.test/join/${CODE}`,
        null,
      ),
    ).toBeNull();
  });

  it('refuses an encoded slash and skips bad percent-encoding', () => {
    expect(
      extractRoomLinkCode(
        SITE,
        `https://campusbyrise.com/join%2F${CODE}`,
        null,
      ),
    ).toBeNull();
    expect(
      extractRoomLinkCode(
        SITE,
        null,
        `https://campusbyrise.com/%E0%A4%A/join/x then https://campusbyrise.com/join/${CODE}`,
      ),
    ).toBe(CODE);
  });

  it.each([
    `https://www.google.com/url?q=https://campusbyrise.com/join/${CODE}&sa=D`,
    `https://zoom.us/j/1,https://campusbyrise.com/join/${CODE}`,
    `See:https://other.test/https://campusbyrise.com/join/${CODE}`,
  ])('finds a link run into another one in %s', (text) => {
    expect(extractRoomLinkCode(SITE, null, text)).toBe(CODE);
  });

  it('keeps a path on the app URL', () => {
    const app = 'https://example.test/campus';
    expect(
      extractRoomLinkCode(
        app,
        `https://example.test/campus/join/${CODE}`,
        null,
      ),
    ).toBe(CODE);
    expect(
      extractRoomLinkCode(app, `https://example.test/join/${CODE}`, null),
    ).toBeNull();
  });
});
