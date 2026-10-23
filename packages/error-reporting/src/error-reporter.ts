import { PostHog } from 'posthog-node';

import { scrubError, scrubExceptionList } from './scrub.js';

/** Long enough to send what is queued, short of a platform's kill. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

export type ErrorLevel = 'fatal' | 'error' | 'warning';

export interface ErrorContext {
  /** The `users.id` of the person it happened to, when there is one. */
  distinctId?: string;
  level?: ErrorLevel;
  properties?: Record<string, string | number | undefined>;
}

export interface ErrorReporter {
  report(error: unknown, context?: ErrorContext): void;
  shutdown(): Promise<void>;
}

export interface ErrorReporterOptions {
  enabled: boolean;
  token?: string;
  host: string;
  service: string;
  environment: string;
  /** The deployed commit. */
  release?: string;
}

const silent: ErrorReporter = {
  report: () => undefined,
  shutdown: async () => undefined,
};

export function createErrorReporter(
  options: ErrorReporterOptions,
): ErrorReporter {
  if (!options.enabled || !options.token) {
    return silent;
  }

  const stamp = {
    service: options.service,
    environment: options.environment,
    release: options.release,
  };
  // Uncaught exceptions are captured too, once this client exists; Node
  // still exits on them.
  const client = new PostHog(options.token, {
    host: options.host,
    disableGeoip: true,
    enableExceptionAutocapture: true,
    before_send: (event) =>
      event && {
        ...event,
        properties: {
          ...event.properties,
          ...stamp,
          $exception_list: scrubExceptionList(
            event.properties?.$exception_list,
          ),
        },
      },
  });

  return {
    report(error, { distinctId, level = 'error', properties } = {}) {
      try {
        client.captureException(scrubError(error), distinctId, {
          ...properties,
          $exception_level: level,
        });
      } catch (err) {
        console.error('Could not report an error to PostHog', err);
      }
    },
    shutdown: () => client.shutdown(SHUTDOWN_TIMEOUT_MS),
  };
}
