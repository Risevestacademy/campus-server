import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  serviceName: string;
  version: string;
  environment: string;
  enabled: boolean;
  metricsEnabled: boolean;
}

export function initTelemetry(options: TelemetryOptions): NodeSDK {
  const instrumentations: Instrumentation[] = [new HttpInstrumentation(), new ExpressInstrumentation()];
  if (options.metricsEnabled) {
    instrumentations.push(new RuntimeNodeInstrumentation());
  }

  const sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        [ATTR_SERVICE_VERSION]: options.version,
        'deployment.environment': options.environment,
      }),
    ),
    instrumentations,
    // Env-driven: OTEL_METRICS_EXPORTER (default: otlp) automatically builds the
    // metric reader. Passing an empty array keeps metrics fully disabled when the
    // feature flag is off.
    metricReaders: options.metricsEnabled ? undefined : [],
    traceExporter: options.enabled ? new OTLPTraceExporter() : undefined,
  });

  if (!options.enabled) {
    return sdk;
  }

  sdk.start();

  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        console.error('Error shutting down telemetry', err);
        process.exit(1);
      });
  });

  return sdk;
}