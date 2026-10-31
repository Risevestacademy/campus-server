import { randomUUID } from 'node:crypto';

import { PostHog } from 'posthog-node';
import { z } from 'zod';

import { EVENTS, type EventName, type EventProperties } from './events.js';

/** Long enough to send what is queued, short of a platform's kill. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

/** Names in a drop's log line can come from a caller, so odd ones aren't shown. */
const PRINTABLE_NAME = /^[$A-Za-z_][\w.]{0,63}$/;

const uuid = z.uuid();

function printable(name: unknown): string {
  return typeof name === 'string' && PRINTABLE_NAME.test(name)
    ? name
    : '(not shown)';
}

/** A strict object reports unknown fields in `keys`, with an empty path. */
function rejectedFields(issues: z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map(printable)
      : [issue.path.map(printable).join('.') || '(properties)'],
  );
}

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
  function drop(event: unknown, reason: string): void {
    try {
      onDropped?.(printable(event), reason);
    } catch {
      // Nothing is left to tell, and the caller must not hear about it.
    }
  }

  function guarded(event: unknown, work: () => void): void {
    try {
      work();
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      drop(event, `could not send: ${name}`);
    }
  }

  function send(
    event: EventName,
    properties: unknown,
    distinctId: string,
    anonymous: boolean,
    { cohortId, correlationId }: TrackOptions,
  ): void {
    const parsed = EVENTS[event].schema.safeParse(properties);
    if (!parsed.success) {
      const fields = rejectedFields(parsed.error.issues);
      drop(event, `invalid fields: ${fields.join(', ')}`);
      return;
    }
    if (cohortId !== undefined && !uuid.safeParse(cohortId).success) {
      drop(event, 'invalid cohort id');
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
        ...(uuid.safeParse(correlationId).success
          ? { correlation_id: correlationId }
          : {}),
        ...(cohortId ? { cohort_id: cohortId } : {}),
        ...(anonymous ? { $process_person_profile: false } : {}),
      },
      // PostHog links no group to an event without a person.
      ...(cohortId && !anonymous ? { groups: { cohort: cohortId } } : {}),
    });
  }

  return {
    track(event, distinctId, properties, options = {}) {
      guarded(event, () => {
        if (!Object.hasOwn(EVENTS, event)) {
          drop(event, 'unknown event');
          return;
        }
        const named = !EVENTS[event].consent || options.consented === true;
        if (named && !uuid.safeParse(distinctId).success) {
          drop(event, 'invalid distinct id');
          return;
        }
        const standIn = uuid.safeParse(options.sessionId).success
          ? (options.sessionId as string)
          : randomUUID();
        send(event, properties, named ? distinctId : standIn, !named, options);
      });
    },
    trackAnonymous(event, properties, options = {}) {
      guarded(event, () => {
        if (!Object.hasOwn(EVENTS, event)) {
          drop(event, 'unknown event');
          return;
        }
        send(event, properties, randomUUID(), true, options);
      });
    },
    identifyPerson(distinctId, properties) {
      guarded('$identify', () => {
        if (!uuid.safeParse(distinctId).success) {
          drop('$identify', 'invalid distinct id');
          return;
        }
        sink.identifyPerson(distinctId, properties);
      });
    },
    identifyCohort(cohortId, properties) {
      guarded('$groupidentify', () => {
        if (!uuid.safeParse(cohortId).success) {
          drop('$groupidentify', 'invalid cohort id');
          return;
        }
        sink.identifyCohort(cohortId, properties);
      });
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
