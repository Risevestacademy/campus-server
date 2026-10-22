import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { annotate, failActiveSpan, traced } from './traced.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  );
});

afterAll(() => {
  trace.disable();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
});

describe('traced', () => {
  it('runs the work in a span, annotated across awaits, ended when it settles', async () => {
    const result = await traced(
      'world.socket.open',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        annotate({ 'world.outcome': 'opened' });
        return 42;
      },
      { attributes: { 'world.cohort_id': 'c-1' } },
    );

    expect(result).toBe(42);
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('world.socket.open');
    expect(span.attributes).toEqual({
      'world.cohort_id': 'c-1',
      'world.outcome': 'opened',
    });
  });

  it('marks a span whose work throws, and rethrows', async () => {
    await expect(
      traced('world.sweep.accounts', async () => {
        throw new Error('database down');
      }),
    ).rejects.toThrow('database down');

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.map((e) => e.name)).toContain('exception');
  });

  it('starts a trace of its own when asked, whatever is running', async () => {
    await traced('outer', () =>
      traced('world.socket.open', async () => undefined, { root: true }),
    );

    const spans = exporter.getFinishedSpans();
    const inner = spans.find((s) => s.name === 'world.socket.open')!;
    const outer = spans.find((s) => s.name === 'outer')!;
    expect(inner.parentSpanContext).toBeUndefined();
    expect(inner.spanContext().traceId).not.toBe(outer.spanContext().traceId);
  });

  it('fails the running span when an error line carrying an error is logged', async () => {
    await traced('world.sweep.sessions', async () => {
      failActiveSpan(50, [{ err: new Error('database down') }, 'could not']);
    });
    await traced('world.sweep.accounts', async () => {
      failActiveSpan(40, [{ err: new Error('degraded') }, 'warned']);
      failActiveSpan(50, [{ userId: 'u-1' }, 'no error here']);
    });

    const [failed, fine] = exporter.getFinishedSpans();
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.events.map((e) => e.name)).toContain('exception');
    expect(fine.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('annotates and fails nothing outside a span', () => {
    expect(() => annotate({ 'world.outcome': 'opened' })).not.toThrow();
    expect(() =>
      failActiveSpan(50, [{ err: new Error('x') }, 'outside']),
    ).not.toThrow();
  });
});
