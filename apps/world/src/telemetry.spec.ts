import { SessionScope, signSessionToken } from '@campus/session';
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
} from '@opentelemetry/sdk-trace';
import type { AddressInfo } from 'node:net';
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
import type { PositionStore } from './infra/positions.js';
import { traced } from './infra/traced.js';
import { spaceIndexFrom } from './movement/spaces.js';
import type { WorldMap } from './movement/world-map.js';

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

const lookup = {
  failFind: false,
  find: async (userId: string) => {
    if (lookup.failFind) throw new Error('postgres is down');
    return {
      id: userId,
      suspended: false,
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
  onSpacesChanged: async () => undefined,
  onProfileChanged: async () => undefined,
  close: async () => undefined,
} as unknown as AccountLookup & { failFind: boolean };

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

beforeAll(async () => {
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    }),
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

  world = await buildWorld({
    env: loadEnv({
      AUTH_SESSION_SECRET: SECRET,
      DEPLOYMENT_ENVIRONMENT: 'development',
      DATABASE_URL: 'postgres://unused',
      CORS_ORIGINS: ORIGIN,
      FF_LOG_LEVEL: 'fatal',
    } as NodeJS.ProcessEnv),
    accounts: lookup,
    positions,
    map,
    reporter: { report: vi.fn(), shutdown: vi.fn() },
  });
  await world.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = world.app.server.address() as AddressInfo;
  url = `ws://127.0.0.1:${port}/socket?cohortId=cohort-1`;
});

afterAll(async () => {
  await world.gateway.stop();
  world.gateway.dispose();
  await world.app.close();
  trace.disable();
  metrics.disable();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
  lookup.failFind = false;
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
});

describe("world's logger", () => {
  it('marks the running span failed when an error line carrying an error is logged', async () => {
    await traced('world.sweep.sessions', async () => {
      world.app.log.fatal({ err: new Error('postgres is down') }, 'could not');
    });

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'world.sweep.sessions');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.map((e) => e.name)).toContain('exception');
  });
});
