import { PostHog } from 'posthog-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { analyticsOver, createAnalytics } from './analytics.js';
import { createTestAnalytics } from './testing.js';

const capture = vi.fn();
const identify = vi.fn();
const groupIdentify = vi.fn();
const shutdown = vi.fn(async () => undefined);

vi.mock('posthog-node', () => ({
  PostHog: vi.fn(function () {
    return { capture, identify, groupIdentify, shutdown };
  }),
}));

const ADA = '11111111-1111-4111-8111-111111111111';
const GRACE = '22222222-2222-4222-8222-222222222222';
const COHORT = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('track', () => {
  it('sends the event with what every event carries', () => {
    const analytics = createTestAnalytics();

    analytics.track(
      'invite.sent',
      ADA,
      { role: 'student', via: 'single' },
      { cohortId: COHORT, correlationId: 'corr-1' },
    );

    expect(analytics.events).toEqual([
      {
        distinctId: ADA,
        event: 'invite.sent',
        properties: {
          role: 'student',
          via: 'single',
          client: 'server',
          app_version: 'test-release',
          environment: 'test',
          correlation_id: 'corr-1',
        },
        groups: { cohort: COHORT },
      },
    ]);
  });

  it('keeps the client an event names', () => {
    const analytics = createTestAnalytics();

    analytics.track('auth.signed_out', ADA, { client: 'mobile' });

    expect(analytics.events[0].properties.client).toBe('mobile');
  });

  it('drops an invalid event, naming the field and never the value', () => {
    const analytics = createTestAnalytics();

    analytics.track('feedback.submitted', ADA, {
      category: 'ada@example.com',
    } as never);

    expect(analytics.events).toEqual([]);
    expect(analytics.dropped).toEqual([
      'feedback.submitted: invalid fields: category',
    ]);
  });

  it('drops a distinct id or cohort that is not a UUID', () => {
    const analytics = createTestAnalytics();

    analytics.track('auth.signed_out', 'ada@example.com', { client: 'web' });
    analytics.track(
      'auth.signed_out',
      ADA,
      { client: 'web' },
      { cohortId: 'ada@example.com' },
    );

    expect(analytics.events).toEqual([]);
    expect(analytics.dropped).toEqual([
      'auth.signed_out: invalid distinct id',
      'auth.signed_out: invalid cohort id',
    ]);
  });

  it('leaves off a correlation id that could hold data, and keeps the event', () => {
    const analytics = createTestAnalytics();

    analytics.track(
      'auth.signed_out',
      ADA,
      { client: 'web' },
      { correlationId: 'ada@example.com' },
    );

    expect(analytics.events).toHaveLength(1);
    expect(analytics.events[0].properties).not.toHaveProperty('correlation_id');
  });

  it('never throws, whatever the sink does', () => {
    const dropped: string[] = [];
    const analytics = analyticsOver(
      {
        capture: () => {
          throw new TypeError('queue full of ada@example.com');
        },
        identifyPerson: () => undefined,
        identifyCohort: () => undefined,
        shutdown: async () => undefined,
      },
      {
        environment: 'test',
        onDropped: (event, reason) => dropped.push(`${event}: ${reason}`),
      },
    );

    expect(() =>
      analytics.track('auth.signed_out', ADA, { client: 'web' }),
    ).not.toThrow();
    expect(dropped).toEqual(['auth.signed_out: could not send: TypeError']);
  });
});

describe('consent', () => {
  const properties = { client: 'web', reconnect: false } as const;

  it('names the person once they have granted it', () => {
    const analytics = createTestAnalytics();

    analytics.track('presence.started', ADA, properties, { consented: true });

    expect(analytics.events[0].distinctId).toBe(ADA);
    expect(analytics.events[0].properties).not.toHaveProperty(
      '$process_person_profiles',
    );
  });

  it.each([[false], [undefined]])(
    'de-identifies when consent is %s, keeping the cohort',
    (consented) => {
      const analytics = createTestAnalytics();

      analytics.track('presence.started', ADA, properties, {
        consented,
        cohortId: COHORT,
      });

      const [sent] = analytics.events;
      expect(sent.distinctId).not.toBe(ADA);
      expect(sent.properties.$process_person_profiles).toBe(false);
      expect(sent.groups).toEqual({ cohort: COHORT });
      expect(JSON.stringify(sent)).not.toContain(ADA);
    },
  );

  it('uses one stand-in for a session', () => {
    const analytics = createTestAnalytics();

    analytics.track('presence.started', ADA, properties, { sessionId: GRACE });
    analytics.track('presence.started', ADA, properties, { sessionId: GRACE });

    expect(analytics.events.map((e) => e.distinctId)).toEqual([GRACE, GRACE]);
  });

  it('sends what needs no consent under the person regardless', () => {
    const analytics = createTestAnalytics();

    analytics.track(
      'auth.signed_out',
      ADA,
      { client: 'web' },
      {
        consented: false,
      },
    );

    expect(analytics.events[0].distinctId).toBe(ADA);
  });
});

describe('trackAnonymous', () => {
  it('uses a new random id and makes no person', () => {
    const analytics = createTestAnalytics();
    const failed = { reason: 'denied', client: 'web' } as const;

    analytics.trackAnonymous('auth.sign_in_failed', failed);
    analytics.trackAnonymous('auth.sign_in_failed', failed);

    const [first, second] = analytics.events;
    expect(first.distinctId).not.toBe(second.distinctId);
    expect(first.properties.$process_person_profiles).toBe(false);
  });
});

describe('createAnalytics', () => {
  const options = {
    enabled: true,
    token: 'phc_test',
    host: 'https://eu.i.posthog.com',
    environment: 'staging',
    release: 'abc123',
  };

  it('sends to PostHog, without resolving an IP address', () => {
    const analytics = createAnalytics(options);

    analytics.track(
      'auth.signed_out',
      ADA,
      { client: 'web' },
      {
        cohortId: COHORT,
      },
    );

    expect(PostHog).toHaveBeenCalledWith('phc_test', {
      host: 'https://eu.i.posthog.com',
      disableGeoip: true,
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: ADA,
        event: 'auth.signed_out',
        groups: { cohort: COHORT },
      }),
    );
  });

  it('sets a person once and a cohort as a group', () => {
    const analytics = createAnalytics(options);

    analytics.identifyPerson(ADA, {
      system_role: 'user',
      first_seen_at: '2026-10-30T00:00:00.000Z',
    });
    analytics.identifyCohort(COHORT, {
      status: 'active',
      start_date: '2026-11-01',
    });

    expect(identify).toHaveBeenCalledWith({
      distinctId: ADA,
      properties: {
        $set: { system_role: 'user' },
        $set_once: { first_seen_at: '2026-10-30T00:00:00.000Z' },
      },
    });
    expect(groupIdentify).toHaveBeenCalledWith({
      groupType: 'cohort',
      groupKey: COHORT,
      properties: { status: 'active', start_date: '2026-11-01' },
    });
  });

  it('bounds the flush on shutdown', async () => {
    await createAnalytics(options).shutdown();

    expect(shutdown).toHaveBeenCalledWith(3_000);
  });

  it.each([[{ enabled: false }], [{ enabled: true, token: undefined }]])(
    'builds no client with %j',
    async (overrides) => {
      const analytics = createAnalytics({ ...options, ...overrides });

      analytics.track('auth.signed_out', ADA, { client: 'web' });
      await analytics.shutdown();

      expect(PostHog).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    },
  );
});
