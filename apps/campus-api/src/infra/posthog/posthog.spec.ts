import { PostHog } from 'posthog-node';

import { initPostHog } from './posthog.js';

vi.mock('posthog-node', () => ({
  PostHog: vi.fn(),
}));

describe('initPostHog', () => {
  beforeEach(() => {
    vi.mocked(PostHog).mockClear();
  });

  it('returns undefined when disabled', () => {
    const client = initPostHog({ enabled: false, host: 'https://us.i.posthog.com' });

    expect(client).toBeUndefined();
    expect(PostHog).not.toHaveBeenCalled();
  });

  it('returns undefined when enabled but no API key is set', () => {
    const client = initPostHog({ enabled: true, host: 'https://us.i.posthog.com' });

    expect(client).toBeUndefined();
    expect(PostHog).not.toHaveBeenCalled();
  });

  it('constructs a client with the given key and host when enabled', () => {
    initPostHog({ enabled: true, apiKey: 'phc_test123', host: 'https://us.i.posthog.com' });

    expect(PostHog).toHaveBeenCalledWith('phc_test123', { host: 'https://us.i.posthog.com' });
  });
});
