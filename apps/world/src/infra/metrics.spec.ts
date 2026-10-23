import {
  MeterProvider,
  MetricReader,
  type DataPoint,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';

import { worldMetrics, type OpenSockets } from './metrics.js';

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

function setUp(sockets: OpenSockets = { all: () => [] }) {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  const recorder = worldMetrics(sockets, provider.getMeter('world'));
  return {
    recorder,
    async points(name: string): Promise<DataPoint<number>[]> {
      const { resourceMetrics } = await reader.collect();
      const metric = resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .find((m) => m.descriptor.name === name);
      return (metric?.dataPoints ?? []) as DataPoint<number>[];
    },
  };
}

function byAttributes(points: DataPoint<number>[]) {
  return points.map(({ attributes, value }) => ({ ...attributes, value }));
}

describe('worldMetrics', () => {
  it('counts what happens to sockets and their messages', async () => {
    const { recorder, points } = setUp();

    recorder.opened();
    recorder.opened();
    recorder.refused('not_a_member');
    recorder.failed();
    recorder.abandoned();
    recorder.closedByServer('rate_limited');
    recorder.closedByServer('heartbeat_missed');
    recorder.received('move');
    recorder.received('move');
    recorder.received('invalid');
    recorder.moved('blocked');
    recorder.sentFrame();
    recorder.sentFrame();
    recorder.sentFrame();

    expect(byAttributes(await points('world.connections.opened'))).toEqual([
      { value: 2 },
    ]);
    expect(byAttributes(await points('world.connections.refused'))).toEqual([
      { reason: 'not_a_member', value: 1 },
    ]);
    expect(byAttributes(await points('world.connections.failed'))).toEqual([
      { value: 1 },
    ]);
    expect(byAttributes(await points('world.connections.abandoned'))).toEqual([
      { value: 1 },
    ]);
    expect(
      byAttributes(await points('world.connections.closed_by_server')),
    ).toEqual(
      expect.arrayContaining([
        { reason: 'rate_limited', value: 1 },
        { reason: 'heartbeat_missed', value: 1 },
      ]),
    );
    expect(byAttributes(await points('world.messages.received'))).toEqual(
      expect.arrayContaining([
        { type: 'move', value: 2 },
        { type: 'invalid', value: 1 },
      ]),
    );
    expect(byAttributes(await points('world.moves'))).toEqual([
      { outcome: 'blocked', value: 1 },
    ]);
    expect(byAttributes(await points('world.frames.sent'))).toEqual([
      { value: 3 },
    ]);
  });

  it('reports the per-frame totals as running counts', async () => {
    const { recorder, points } = setUp();

    recorder.sentFrame();
    expect(byAttributes(await points('world.frames.sent'))).toEqual([
      { value: 1 },
    ]);
    recorder.sentFrame();
    expect(byAttributes(await points('world.frames.sent'))).toEqual([
      { value: 2 },
    ]);
  });

  it("labels only world's close codes and the standard ones", async () => {
    const { recorder, points } = setUp();

    recorder.closed(1006);
    recorder.closed(1008);
    recorder.closed(4000);
    recorder.closed(4001);
    recorder.closed(4321);

    expect(byAttributes(await points('world.connections.closed'))).toEqual(
      expect.arrayContaining([
        { code: 1006, value: 1 },
        { code: 1008, value: 1 },
        { code: 4000, value: 1 },
        { code: 'other', value: 2 },
      ]),
    );
  });

  it('stops reading the sockets once disposed', async () => {
    let reads = 0;
    const { recorder, points } = setUp({
      all: () => {
        reads += 1;
        return [{ cohortId: 'c-1', socket: { bufferedAmount: 0 } }];
      },
    });

    await points('world.connections');
    const before = reads;
    recorder.dispose();
    await points('world.connections');
    expect(reads).toBe(before);
  });

  it('reads open sockets by cohort, and the largest unsent buffer', async () => {
    const sockets = [
      { cohortId: 'c-1', socket: { bufferedAmount: 10 } },
      { cohortId: 'c-1', socket: { bufferedAmount: 4_096 } },
      { cohortId: 'c-2', socket: { bufferedAmount: 0 } },
    ];
    const { points } = setUp({ all: () => sockets });

    expect(byAttributes(await points('world.connections'))).toEqual(
      expect.arrayContaining([
        { cohort_id: 'c-1', value: 2 },
        { cohort_id: 'c-2', value: 1 },
      ]),
    );
    expect(byAttributes(await points('world.socket.buffered'))).toEqual([
      { value: 4_096 },
    ]);
  });
});
