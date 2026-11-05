import { SessionScope, signSessionToken } from '@campus/session';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  MeterProvider,
  MetricReader,
  type DataPoint,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { AddressInfo, Socket } from 'node:net';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import WebSocket from 'ws';

import { buildWorld, type World } from './app.js';
import type { AccountLookup } from './infra/accounts.js';
import { loadEnv } from './infra/env.js';
import { fastifyOtelOptions } from './infra/fastify-otel.js';
import type { PositionStore } from './infra/positions.js';
import { traced } from './infra/traced.js';
import { spaceIndexFrom } from './movement/spaces.js';
import type { WorldMap } from './movement/world-map.js';
import { QUIET_ROUTES } from './quiet-routes.js';

/**
 * world's telemetry as it is wired: a real meter and tracer behind the
 * OpenTelemetry API, and real sockets through the gateway.
 */

const SECRET = 'a-world-session-secret-of-at-least-32-chars';
const ORIGIN = 'https://campus.example.com';

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

const reader = new TestReader();
const exporter = new InMemorySpanExporter();

/** Every span as it starts: a span that never ends is never exported. */
const started: Span[] = [];
const startedSpans: SpanProcessor = {
  onStart: (span) => void started.push(span as Span),
  onEnd: () => undefined,
  forceFlush: async () => undefined,
  shutdown: async () => undefined,
};

const lookup = {
  failFind: false,
  suspended: false,
  /** While set, the account read waits for it: the client can leave meanwhile. */
  hold: undefined as Promise<void> | undefined,
  reading: undefined as (() => void) | undefined,
  find: async (userId: string) => {
    lookup.reading?.();
    await lookup.hold;
    if (lookup.failFind) throw new Error('postgres is down');
    return {
      id: userId,
      suspended: lookup.suspended,
      admin: false,
      systemRole: 'user',
      sessionEpoch: 0,
      displayName: null,
      spriteKey: null,
    };
  },
  liveSessions: async (ids: readonly string[]) => new Set(ids),
  liveMembership: async () => true,
  liveMemberships: async () => new Set<string>(),
  memberships: async () => new Map(),
  spacesOn: async () => new Map(),
  roomLinkPassesOn: async () => [],
  onSpacesChanged: async () => undefined,
  onDesksChanged: async () => undefined,
  notifyEntryRequestAnswered: async () => undefined,
  onProfileChanged: async () => undefined,
  close: async () => undefined,
} as unknown as AccountLookup & {
  failFind: boolean;
  suspended: boolean;
  hold: Promise<void> | undefined;
  reading: (() => void) | undefined;
};

/** A saved place that cannot be read: joining the avatar to it throws. */
const unreadable = {
  x: 0,
  y: 0,
  get facing(): never {
    throw new Error('saved position is corrupt');
  },
};

const positions = {
  next: undefined as unknown,
  load: async () => positions.next,
  save: async () => undefined,
  forget: async () => undefined,
  ready: async () => true,
  close: async () => undefined,
} as unknown as PositionStore & { next: unknown };

const map: WorldMap = {
  id: 'campus',
  version: 'v-test',
  grid: {
    width: 5,
    height: 5,
    spawn: { x: 0, y: 0 },
    walls: new Uint8Array(25),
  },
  spaces: spaceIndexFrom({
    widthTiles: 5,
    heightTiles: 5,
    collisions: [],
    spawn: { x: 0, y: 0 },
    spaces: [],
    portals: [],
    desks: [],
  }),
};

let world: World;
let url: string;
let httpUrl: string;
let fastifyOtel: FastifyOtelInstrumentation;

beforeAll(async () => {
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter }), startedSpans],
    }),
  );
  // As index.ts wires it: it attaches to each Fastify instance made after it.
  fastifyOtel = new FastifyOtelInstrumentation(
    fastifyOtelOptions(QUIET_ROUTES),
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

  world = await buildWorld({
    env: loadEnv({
      AUTH_SESSION_SECRET: SECRET,
      DEPLOYMENT_ENVIRONMENT: 'development',
      DATABASE_URL: 'postgres://unused',
      CORS_ORIGINS: ORIGIN,
      FF_LOG_LEVEL: 'error',
    } as NodeJS.ProcessEnv),
    accounts: lookup,
    positions,
    map,
    reporter: { report: vi.fn(), shutdown: vi.fn() },
  });
  await world.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = world.app.server.address() as AddressInfo;
  url = `ws://127.0.0.1:${port}/socket?cohortId=cohort-1`;
  httpUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await world.gateway.stop();
  world.gateway.dispose();
  await world.app.close();
  fastifyOtel.disable();
  trace.disable();
  metrics.disable();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
  started.length = 0;
  lookup.failFind = false;
  lookup.suspended = false;
  lookup.hold = undefined;
  lookup.reading = undefined;
  positions.next = undefined;
});

async function count(name: string, attributes: object = {}): Promise<number> {
  const { resourceMetrics } = await reader.collect();
  const points = (resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((m) => m.descriptor.name === name)?.dataPoints ??
    []) as DataPoint<number>[];
  return points
    .filter((point) =>
      Object.entries(attributes).every(([k, v]) => point.attributes[k] === v),
    )
    .reduce((sum, point) => sum + point.value, 0);
}

async function counts() {
  return {
    opened: await count('world.connections.opened'),
    refused: await count('world.connections.refused'),
    failed: await count('world.connections.failed'),
    abandoned: await count('world.connections.abandoned'),
  };
}

/** Opens a socket and waits for the welcome or the close, then lets go. */
async function attempt(cookie?: string): Promise<{ closeCode?: number }> {
  const ws = new WebSocket(url, {
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
  });
  const outcome = await new Promise<{ closeCode?: number }>((resolve) => {
    ws.on('message', (raw) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === 'welcome') {
        resolve({});
      }
    });
    ws.on('close', (code) => resolve({ closeCode: code }));
    ws.on('error', () => undefined);
  });
  ws.close();
  return outcome;
}

/**
 * Opens a socket and resets the connection while world is still reading the
 * account, then lets the read finish once world has seen it go. world reads
 * nothing while it decides, so only a reset tells it, as when a tab is killed.
 */
async function leaveWhileDeciding(cookie: string): Promise<void> {
  let release!: () => void;
  lookup.hold = new Promise((resolve) => (release = resolve));
  const reading = new Promise<void>((resolve) => (lookup.reading = resolve));
  const closedBefore = await count('world.connections.closed');
  const ws = new WebSocket(url, { headers: { origin: ORIGIN, cookie } });
  ws.on('error', () => undefined);
  await reading;
  (ws as unknown as { _socket: Socket })._socket.resetAndDestroy();
  await vi.waitFor(async () => {
    if ((await count('world.connections.closed')) === closedBefore) {
      throw new Error('world has not seen it go');
    }
  });
  release();
}

async function session(userId: string): Promise<string> {
  const { token } = await signSessionToken(
    {
      epoch: 0,
      userId,
      email: `${userId}@campus.local`,
      scope: SessionScope.FullAccess,
    },
    { secret: SECRET, ttlMinutes: 30 },
  );
  return `campus_session=${token}`;
}

async function socketSpan() {
  return vi.waitFor(() => {
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'world.socket.open');
    if (!span) throw new Error('not ended yet');
    return span;
  });
}

describe('an upgrade is counted once, by how it ends', () => {
  it('refused: no session', async () => {
    const before = await counts();

    expect(await attempt()).toEqual({ closeCode: 1008 });

    const after = await counts();
    expect(after.refused - before.refused).toBe(1);
    expect(
      await count('world.connections.refused', { reason: 'no_token' }),
    ).toBeGreaterThan(0);
    expect(after.opened - before.opened).toBe(0);
    expect(after.failed - before.failed).toBe(0);
    expect((await socketSpan()).attributes).toMatchObject({
      'world.outcome': 'refused',
      'world.refusal': 'no_token',
      'world.cohort_id': 'cohort-1',
    });
  });

  it('opened: a live session, with the person and cohort on its span', async () => {
    const before = await counts();

    expect(await attempt(await session('ada'))).toEqual({});

    const after = await counts();
    expect(after.opened - before.opened).toBe(1);
    expect(after.refused - before.refused).toBe(0);
    expect((await socketSpan()).attributes).toMatchObject({
      'world.outcome': 'opened',
      'world.cohort_id': 'cohort-1',
      'user.id': 'ada',
    });
  });

  it('failed: the upgrade could not be decided', async () => {
    lookup.failFind = true;
    const before = await counts();

    expect(await attempt(await session('grace'))).toEqual({ closeCode: 1011 });

    const after = await counts();
    expect(after.failed - before.failed).toBe(1);
    expect(after.refused - before.refused).toBe(0);
    expect((await socketSpan()).attributes['world.outcome']).toBe('failed');
  });

  it('failed: something after the decision threw, before the socket opened', async () => {
    positions.next = unreadable;
    const before = await counts();

    const { closeCode } = await attempt(await session('linus'));

    expect(closeCode).toBeDefined();
    const after = await counts();
    expect(after.failed - before.failed).toBe(1);
    expect(after.opened - before.opened).toBe(0);
    const span = await socketSpan();
    expect(span.attributes['world.outcome']).toBe('failed');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('refused: the account was refused, though the client left while world decided', async () => {
    lookup.suspended = true;
    const before = await counts();

    await leaveWhileDeciding(await session('margaret'));

    const span = await socketSpan();
    const after = await counts();
    expect(span.attributes).toMatchObject({
      'world.outcome': 'refused',
      'world.refusal': 'account_suspended',
    });
    expect(after.refused - before.refused).toBe(1);
    expect(after.abandoned - before.abandoned).toBe(0);
  });

  it('abandoned: the client left before world let it in', async () => {
    const before = await counts();

    await leaveWhileDeciding(await session('barbara'));

    const span = await socketSpan();
    const after = await counts();
    expect(span.attributes['world.outcome']).toBe('abandoned');
    expect(after.abandoned - before.abandoned).toBe(1);
    expect(after.opened - before.opened).toBe(0);
    expect(after.refused - before.refused).toBe(0);
  });
});

/** Fastify's request spans, ended or not. */
function requestSpans(): Span[] {
  return started.filter((s) => s.name === 'request');
}

async function requestSpanFor(route: string): Promise<Span> {
  return vi.waitFor(() => {
    const span = requestSpans().find(
      (s) => s.attributes['http.route'] === route && s.ended,
    );
    if (!span) throw new Error(`no ended request span for ${route}`);
    return span;
  });
}

describe("Fastify's request spans", () => {
  it('leave the socket upgrade out', async () => {
    expect(await attempt(await session('ada'))).toEqual({});
    await fetch(`${httpUrl}/schema.json`);

    await requestSpanFor('/schema.json');
    expect(requestSpans().map((s) => s.attributes['url.path'])).toEqual([
      '/schema.json',
    ]);
  });

  it("keep a query string's values off the span", async () => {
    await fetch(`${httpUrl}/schema.json?token=secret`);

    const span = await requestSpanFor('/schema.json');
    expect(span.attributes['url.path']).toBe('/schema.json');
    expect(
      JSON.stringify(
        started.map((s) => [s.name, s.attributes, s.events, s.links]),
      ),
    ).not.toContain('secret');
  });
});

describe("world's logger", () => {
  it.each([
    ['an error', 'error'],
    ['a fatal', 'fatal'],
  ] as const)(
    'marks the running span failed when %s line carrying an error is logged',
    async (_, level) => {
      await traced('world.sweep.sessions', async () => {
        world.app.log[level](
          { err: new Error('postgres is down') },
          'could not',
        );
      });

      const span = exporter
        .getFinishedSpans()
        .find((s) => s.name === 'world.sweep.sessions');
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.events.map((e) => e.name)).toContain('exception');
    },
  );

  it('leaves the span alone for an error line without an error', async () => {
    await traced('world.sweep.sessions', async () => {
      world.app.log.error({ cohortId: 'cohort-1' }, 'nothing thrown');
    });

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'world.sweep.sessions');
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span?.events).toEqual([]);
  });
});
