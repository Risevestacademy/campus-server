import { describe, expect, it } from 'vitest';

import {
  matchesPath,
  pathOf,
  redactQuery,
  redactedRequestUrl,
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
