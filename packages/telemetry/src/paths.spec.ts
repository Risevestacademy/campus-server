import { describe, expect, it } from 'vitest';

import {
  matchesPath,
  pathOf,
  redactQuery,
  redactedRequestUrl,
  redactedUrlParts,
} from './paths.js';

describe('pathOf', () => {
  it('drops the query string', () => {
    expect(pathOf('/v1/auth/google/callback?code=abc&state=xyz')).toBe(
      '/v1/auth/google/callback',
    );
    expect(pathOf('/v1/invites')).toBe('/v1/invites');
    expect(pathOf(undefined)).toBe('');
  });
});

describe('matchesPath', () => {
  const paths = ['/v1/health', '/docs'];

  it('matches a listed path, what is under it, and either with a query', () => {
    expect(matchesPath('/v1/health', paths)).toBe(true);
    expect(matchesPath('/v1/health/', paths)).toBe(true);
    expect(matchesPath('/docs/assets/app.js', paths)).toBe(true);
    expect(matchesPath('/v1/health?verbose=1', paths)).toBe(true);
  });

  it('leaves lookalikes and everything else alone', () => {
    expect(matchesPath('/v1/health-check', paths)).toBe(false);
    expect(matchesPath('/docsomething', paths)).toBe(false);
    expect(matchesPath('/v1/invites', paths)).toBe(false);
    expect(matchesPath(undefined, paths)).toBe(false);
  });
});

describe('redactQuery', () => {
  it('keeps the names and drops the values', () => {
    expect(redactQuery('/schema.json?token=secret&page=2')).toBe(
      'token=REDACTED&page=REDACTED',
    );
  });

  it('has nothing to say without a query string', () => {
    expect(redactQuery('/schema.json')).toBeUndefined();
    expect(redactQuery('/schema.json?')).toBeUndefined();
    expect(redactQuery(undefined)).toBeUndefined();
  });
});

describe('redactedRequestUrl', () => {
  it('rebuilds the URL with its query values redacted', () => {
    expect(
      redactedRequestUrl({
        protocol: 'https:',
        hostname: 'oauth2.googleapis.com',
        path: '/token?access_token=secret',
      }),
    ).toBe('https://oauth2.googleapis.com/token?access_token=REDACTED');
  });

  it('names a port only when it is not the default', () => {
    expect(
      redactedRequestUrl({
        protocol: 'http:',
        host: 'localhost',
        port: 7880,
        path: '/twirp?key=secret',
      }),
    ).toBe('http://localhost:7880/twirp?key=REDACTED');
    expect(
      redactedRequestUrl({
        protocol: 'https:',
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails?x=1',
      }),
    ).toBe('https://api.resend.com/emails?x=REDACTED');
  });

  it('leaves a URL without a query string to the instrumentation', () => {
    expect(
      redactedRequestUrl({ hostname: 'api.resend.com', path: '/emails' }),
    ).toBeUndefined();
  });
});

describe('redactedUrlParts', () => {
  it('rebuilds a fetch URL with its query values redacted, and gives the query', () => {
    expect(
      redactedUrlParts(
        'https://oauth2.googleapis.com',
        '/tokeninfo?id_token=x&a=b',
      ),
    ).toEqual({
      full: 'https://oauth2.googleapis.com/tokeninfo?id_token=REDACTED&a=REDACTED',
      query: 'id_token=REDACTED&a=REDACTED',
    });
    expect(
      redactedUrlParts('https://api.resend.com', '/emails'),
    ).toBeUndefined();
  });
});

describe('redactedRequestUrl, hosts', () => {
  it('takes the port off a host that carries one', () => {
    expect(
      redactedRequestUrl({ host: 'livekit.internal:8080', path: '/x?k=v' }),
    ).toBe('http://livekit.internal:8080/x?k=REDACTED');
    expect(
      redactedRequestUrl({
        host: 'livekit.internal:8080',
        port: 8080,
        path: '/x?k=v',
      }),
    ).toBe('http://livekit.internal:8080/x?k=REDACTED');
  });

  it('keeps an IPv6 address in brackets', () => {
    expect(
      redactedRequestUrl({ hostname: '::1', port: 7880, path: '/x?k=v' }),
    ).toBe('http://[::1]:7880/x?k=REDACTED');
    expect(redactedRequestUrl({ host: '[::1]:7880', path: '/x?k=v' })).toBe(
      'http://[::1]:7880/x?k=REDACTED',
    );
  });

  it('still redacts when URL cannot parse the host, as with a zone id', () => {
    expect(
      redactedRequestUrl({ hostname: 'fe80::1%eth0', path: '/x?k=v' }),
    ).toBe('http://[fe80::1%eth0]/x?k=REDACTED');
  });
});

describe('matchesPath, case', () => {
  it('matches whatever the case, as Express routes do', () => {
    expect(matchesPath('/V1/Health', ['/v1/health'])).toBe(true);
    expect(matchesPath('/DOCS/assets/app.js', ['/docs'])).toBe(true);
  });
});
