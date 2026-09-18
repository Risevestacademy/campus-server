import { isUnloggedRoute } from './logger.module.js';

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
