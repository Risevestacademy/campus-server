import type { IncomingMessage, RequestOptions } from 'node:http';
import { register } from 'node:module';

import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import {
  defaultResource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import { matchesPath, redactQuery, redactedRequestUrl } from './paths.js';

/** Long enough to send what is buffered, short of a platform's kill. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface TelemetryOptions {
  serviceName: string;
  /** The deployed commit. */
  version: string;
  environment: string;
  metrics: boolean;
  /** Paths, and what is under them, whose requests are not traced. */
  untracedPaths?: readonly string[];
  /** What the app needs beyond HTTP and pino. */
  instrumentations?: Instrumentation[];
  /** Instrumented packages loaded through `import`: see the README. */
  esmModules?: readonly string[];
}

export interface Telemetry {
  /** Rejects if what is buffered cannot be sent in time. */
  shutdown(): Promise<void>;
}

/** Starts the SDK. Call it before importing the app: see the README. */
export function startTelemetry(options: TelemetryOptions): Telemetry {
  if (options.esmModules?.length) {
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
      data: { include: [...options.esmModules] },
    });
  }
  const untraced = options.untracedPaths ?? [];
  const sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        [ATTR_SERVICE_VERSION]: options.version,
        'deployment.environment': options.environment,
      }),
    ),
    // Undefined lets the SDK build the OTLP reader; empty turns metrics off.
    metricReaders: options.metrics ? undefined : [],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request: IncomingMessage) =>
          matchesPath(request.url, untraced),
        // Override what the instrumentation records: no query values, and no
        // client address, which is personal data.
        startIncomingSpanHook: (request: IncomingMessage) => ({
          'url.query': redactQuery(request.url),
          'client.address': undefined,
          'network.peer.address': undefined,
        }),
        startOutgoingSpanHook: (request: RequestOptions) => {
          const url = redactedRequestUrl(request);
          return url ? { 'url.full': url } : {};
        },
      }),
      new PinoInstrumentation(),
      ...(options.metrics ? [new RuntimeNodeInstrumentation()] : []),
      ...(options.instrumentations ?? []),
    ],
  });
  sdk.start();

  return {
    shutdown: () =>
      Promise.race([
        sdk.shutdown(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('Telemetry did not flush in time')),
            SHUTDOWN_TIMEOUT_MS,
          ).unref();
        }),
      ]),
  };
}
