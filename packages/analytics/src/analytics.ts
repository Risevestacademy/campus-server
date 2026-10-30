import { randomUUID } from 'node:crypto';

import { PostHog } from 'posthog-node';
import { z } from 'zod';

import { EVENTS, type EventName, type EventProperties } from './events.js';

/** Long enough to send what is queued, short of a platform's kill. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

/** A caller can send any correlation id, so one that could hold data is left off. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const uuid = z.uuid();

export interface TrackOptions {
  /** Sends the event under this cohort's PostHog group. */
  cohortId?: string;
  correlationId?: string;
  /** Whether the person granted consent. Unset counts as not granted. */
  consented?: boolean;
  /** Stands in for the person on a de-identified event, for one session. */
  sessionId?: string;
}

export interface PersonProperties {
  system_role: string;
  first_seen_at: string;
}

export interface CohortProperties {
  status: string;
  start_date: string;
}

export interface Analytics {
  /** Queues the event. Never throws: an invalid one is dropped and named. */
  track<E extends EventName>(
    event: E,
    distinctId: string,
    properties: EventProperties<E>,
    options?: TrackOptions,
  ): void;
  /** For an event with no known person, such as a failed sign-in. */
  trackAnonymous<E extends EventName>(
    event: E,
    properties: EventProperties<E>,
    options?: Pick<TrackOptions, 'correlationId'>,
  ): void;
  identifyPerson(distinctId: string, properties: PersonProperties): void;
  identifyCohort(cohortId: string, properties: CohortProperties): void;
  shutdown(): Promise<void>;
}

export interface CapturedEvent {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  groups?: { cohort: string };
}

/** Where validated events go: PostHog, nowhere, or a test's list. */
export interface AnalyticsSink {
  capture(event: CapturedEvent): void;
  identifyPerson(distinctId: string, properties: PersonProperties): void;
  identifyCohort(cohortId: string, properties: CohortProperties): void;
  shutdown(): Promise<void>;
}

export interface AnalyticsStamp {
  environment: string;
  /** The deployed commit. */
  release?: string;
  /** Told what was dropped and which fields failed, never their values. */
  onDropped?: (event: string, reason: string) => void;
}

export function analyticsOver(
  sink: AnalyticsSink,
  { environment, release, onDropped }: AnalyticsStamp,
): Analytics {
  function send(
    event: EventName,
    properties: unknown,
    distinctId: string,
    anonymous: boolean,
    { cohortId, correlationId }: TrackOptions,
  ): void {
    try {
      const parsed = EVENTS[event].schema.safeParse(properties);
      if (!parsed.success) {
        const fields = parsed.error.issues.map((i) => i.path.join('.'));
        onDropped?.(event, `invalid fields: ${fields.join(', ')}`);
        return;
      }
      if (cohortId !== undefined && !uuid.safeParse(cohortId).success) {
        onDropped?.(event, 'invalid cohort id');
        return;
      }
      const data = parsed.data as Record<string, unknown>;
      sink.capture({
        distinctId,
        event,
        properties: {
          ...data,
          client: data.client ?? 'server',
          app_version: release,
          environment,
          ...(correlationId && OPAQUE_ID.test(correlationId)
            ? { correlation_id: correlationId }
            : {}),
          ...(anonymous ? { $process_person_profiles: false } : {}),
        },
        ...(cohortId ? { groups: { cohort: cohortId } } : {}),
      });
    } catch (err) {
      onDropped?.(event, `could not send: ${(err as Error).name}`);
    }
  }

  return {
    track(event, distinctId, properties, options = {}) {
      const named = !EVENTS[event].consent || options.consented === true;
      if (named && !uuid.safeParse(distinctId).success) {
        onDropped?.(event, 'invalid distinct id');
        return;
      }
      const standIn = uuid.safeParse(options.sessionId).success
        ? (options.sessionId as string)
        : randomUUID();
      send(event, properties, named ? distinctId : standIn, !named, options);
    },
    trackAnonymous(event, properties, options = {}) {
      send(event, properties, randomUUID(), true, options);
    },
    identifyPerson(distinctId, properties) {
      if (!uuid.safeParse(distinctId).success) {
        onDropped?.('$identify', 'invalid distinct id');
        return;
      }
      try {
        sink.identifyPerson(distinctId, properties);
      } catch (err) {
        onDropped?.('$identify', `could not send: ${(err as Error).name}`);
      }
    },
    identifyCohort(cohortId, properties) {
      if (!uuid.safeParse(cohortId).success) {
        onDropped?.('$groupidentify', 'invalid cohort id');
        return;
      }
      try {
        sink.identifyCohort(cohortId, properties);
      } catch (err) {
        onDropped?.('$groupidentify', `could not send: ${(err as Error).name}`);
      }
    },
    shutdown: () => sink.shutdown(),
  };
}

const nowhere: AnalyticsSink = {
  capture: () => undefined,
  identifyPerson: () => undefined,
  identifyCohort: () => undefined,
  shutdown: async () => undefined,
};

function postHogSink(token: string, host: string): AnalyticsSink {
  const client = new PostHog(token, { host, disableGeoip: true });
  return {
    capture: (event) => client.capture(event),
    identifyPerson(distinctId, { first_seen_at, ...rest }) {
      client.identify({
        distinctId,
        properties: { $set: rest, $set_once: { first_seen_at } },
      });
    },
    identifyCohort(cohortId, properties) {
      client.groupIdentify({
        groupType: 'cohort',
        groupKey: cohortId,
        properties,
      });
    },
    shutdown: () => client.shutdown(SHUTDOWN_TIMEOUT_MS),
  };
}

export interface AnalyticsOptions extends AnalyticsStamp {
  enabled: boolean;
  token?: string;
  host: string;
}

export function createAnalytics({
  enabled,
  token,
  host,
  ...stamp
}: AnalyticsOptions): Analytics {
  return analyticsOver(
    enabled && token ? postHogSink(token, host) : nowhere,
    stamp,
  );
}
