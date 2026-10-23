import {
  isUnloggedRoute,
  routeOnceFinished,
  serializeRequest,
} from './logger.module.js';

describe('isUnloggedRoute', () => {
  it('drops uptime probes and the API reference', () => {
    expect(isUnloggedRoute('/v1/health')).toBe(true);
    expect(isUnloggedRoute('/docs')).toBe(true);
    expect(isUnloggedRoute('/docs-json')).toBe(true);
  });

  it('matches on the path, so query strings do not slip through', () => {
    expect(isUnloggedRoute('/v1/health?verbose=1')).toBe(true);
    expect(isUnloggedRoute('/docs?theme=dark')).toBe(true);
  });

  it('drops the assets the reference loads beneath itself', () => {
    expect(isUnloggedRoute('/docs/assets/app.js')).toBe(true);
  });

  it('keeps everything else, including lookalikes', () => {
    expect(isUnloggedRoute('/v1/invites')).toBe(false);
    expect(isUnloggedRoute('/v1/health-check')).toBe(false);
    expect(isUnloggedRoute('/docsomething')).toBe(false);
    expect(isUnloggedRoute('/health')).toBe(false);
    expect(isUnloggedRoute(undefined)).toBe(false);
  });
});

describe('serializeRequest', () => {
  it('logs the path and never the query string', () => {
    expect(
      serializeRequest({
        id: 'corr-1',
        method: 'GET',
        url: '/v1/auth/google/callback?code=4/0Aabc&state=xyz',
        remoteAddress: '10.0.0.1',
        remotePort: 4321,
      }),
    ).toEqual({
      id: 'corr-1',
      method: 'GET',
      url: '/v1/auth/google/callback',
      remoteAddress: '10.0.0.1',
      remotePort: 4321,
    });
  });
});

describe('routeOnceFinished', () => {
  const req = { route: { path: '/v1/invites/:id/revoke' } };

  it('names the route once the response is done', () => {
    expect(routeOnceFinished(req, { writableEnded: true })).toEqual({
      route: '/v1/invites/:id/revoke',
    });
  });

  it('adds nothing before then, when the route is not known yet', () => {
    expect(routeOnceFinished(req, { writableEnded: false })).toEqual({});
    expect(routeOnceFinished({}, { writableEnded: true })).toEqual({
      route: undefined,
    });
  });
});
