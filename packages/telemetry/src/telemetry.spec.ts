import type { IncomingMessage, RequestOptions } from 'node:http';
import { register } from 'node:module';

import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTelemetry } from './telemetry.js';

const start = vi.fn();
const shutdown = vi.fn(async () => undefined);

vi.mock('node:module', () => ({ register: vi.fn() }));
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn(function () {
    return { start, shutdown };
  }),
}));

const options = {
  serviceName: 'campus-api',
  version: 'abc123',
  environment: 'staging',
  metrics: false,
  untracedPaths: ['/v1/health'],
};

type SdkConfig = Record<string, unknown> & {
  metricReaders?: unknown[];
  instrumentations: unknown[];
  resource: { attributes: Record<string, unknown> };
};

function sdkConfig(): SdkConfig {
  return vi.mocked(NodeSDK).mock.calls[0][0] as unknown as SdkConfig;
}

function http(): HttpInstrumentation {
  return sdkConfig().instrumentations[0] as HttpInstrumentation;
}

describe('startTelemetry', () => {
  beforeEach(() => {
    vi.mocked(NodeSDK).mockClear();
    vi.mocked(register).mockClear();
    start.mockClear();
    shutdown.mockReset();
    shutdown.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the SDK, naming the service, release and environment', () => {
    startTelemetry(options);

    expect(start).toHaveBeenCalledTimes(1);
    expect(sdkConfig().resource.attributes).toMatchObject({
      'service.name': 'campus-api',
      'service.version': 'abc123',
      'deployment.environment': 'staging',
    });
  });

  // The SDK builds an OTLP exporter for each from OTEL_TRACES_EXPORTER and
  // OTEL_LOGS_EXPORTER, both otlp unless set; passing any of these would
  // replace that.
  it('leaves the trace and log exporters to the environment', () => {
    startTelemetry(options);

    for (const key of [
      'traceExporter',
      'spanProcessors',
      'logRecordProcessors',
      'logRecordProcessor',
    ]) {
      expect(sdkConfig()[key]).toBeUndefined();
    }
  });

  it('instruments HTTP, fetch and pino, sending log lines, and adds what the app asks for', () => {
    const extra = new HttpInstrumentation();
    startTelemetry({ ...options, instrumentations: [extra] });

    const { instrumentations } = sdkConfig();
    expect(instrumentations[0]).toBeInstanceOf(HttpInstrumentation);
    expect(
      instrumentations.some((i) => i instanceof UndiciInstrumentation),
    ).toBe(true);
    const pino = instrumentations.find(
      (i) => i instanceof PinoInstrumentation,
    ) as PinoInstrumentation;
    expect(pino.getConfig().disableLogSending).not.toBe(true);
    expect(instrumentations.at(-1)).toBe(extra);
  });

  it('records no query values on a fetch', () => {
    startTelemetry(options);

    const undici = sdkConfig().instrumentations.find(
      (i) => i instanceof UndiciInstrumentation,
    ) as UndiciInstrumentation;
    const hook = undici.getConfig().startSpanHook!;
    expect(
      hook({
        origin: 'https://oauth2.googleapis.com',
        path: '/tokeninfo?id_token=secret',
      } as Parameters<typeof hook>[0]),
    ).toEqual({
      'url.full': 'https://oauth2.googleapis.com/tokeninfo?id_token=REDACTED',
      'url.query': 'id_token=REDACTED',
    });
    expect(
      hook({
        origin: 'https://api.resend.com',
        path: '/emails',
      } as Parameters<typeof hook>[0]),
    ).toEqual({});
  });

  it('leaves metrics off unless asked', () => {
    startTelemetry(options);

    expect(sdkConfig().metricReaders).toEqual([]);
    expect(
      sdkConfig().instrumentations.some(
        (i) => i instanceof RuntimeNodeInstrumentation,
      ),
    ).toBe(false);
  });

  it('collects runtime metrics when asked', () => {
    startTelemetry({ ...options, metrics: true });

    expect(sdkConfig().metricReaders).toBeUndefined();
    expect(
      sdkConfig().instrumentations.some(
        (i) => i instanceof RuntimeNodeInstrumentation,
      ),
    ).toBe(true);
  });

  it('does not trace the untraced paths or what is under them', () => {
    startTelemetry(options);

    const ignore = http().getConfig().ignoreIncomingRequestHook!;
    expect(ignore({ url: '/v1/health' } as IncomingMessage)).toBe(true);
    expect(ignore({ url: '/v1/health/' } as IncomingMessage)).toBe(true);
    expect(ignore({ url: '/v1/invites' } as IncomingMessage)).toBe(false);
  });

  it('records no query values and no client address on a request span', () => {
    startTelemetry(options);

    const hook = http().getConfig().startIncomingSpanHook!;
    expect(
      hook({ url: '/v1/invites?token=secret' } as IncomingMessage),
    ).toEqual({
      'url.query': 'token=REDACTED',
      'client.address': undefined,
      'network.peer.address': undefined,
    });
  });

  it('sends no OAuth code or state from the Google callback', () => {
    startTelemetry(options);

    const hook = http().getConfig().startIncomingSpanHook!;
    const attributes = hook({
      url: '/v1/auth/google/callback?code=4/0Aabc-code&state=xyz-state',
    } as IncomingMessage);
    expect(attributes['url.query']).toBe('code=REDACTED&state=REDACTED');
    expect(JSON.stringify(attributes)).not.toMatch(/4\/0Aabc-code|xyz-state/);
  });

  it('records no query values on an outgoing call', () => {
    startTelemetry(options);

    const hook = http().getConfig().startOutgoingSpanHook!;
    expect(
      hook({
        protocol: 'https:',
        hostname: 'example.com',
        path: '/x?access_token=secret',
      } as RequestOptions),
    ).toEqual({ 'url.full': 'https://example.com/x?access_token=REDACTED' });
    expect(
      hook({ protocol: 'https:', hostname: 'example.com', path: '/x' }),
    ).toEqual({});
  });

  it('hooks only the ES modules named, and none unless asked', () => {
    startTelemetry(options);
    expect(register).not.toHaveBeenCalled();

    startTelemetry({ ...options, esmModules: ['express'] });
    expect(register).toHaveBeenCalledWith(
      '@opentelemetry/instrumentation/hook.mjs',
      expect.any(String),
      { data: { include: ['express'] } },
    );
  });

  it('flushes on shutdown', async () => {
    await startTelemetry(options).shutdown();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('gives up on a flush that does not finish in time', async () => {
    vi.useFakeTimers();
    shutdown.mockReturnValue(new Promise(() => undefined));

    const flushed = startTelemetry(options).shutdown();
    const outcome = expect(flushed).rejects.toThrow(/did not flush in time/);
    await vi.advanceTimersByTimeAsync(3_000);
    await outcome;
  });
});
