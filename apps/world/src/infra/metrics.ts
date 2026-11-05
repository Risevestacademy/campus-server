import {
  metrics,
  type Meter,
  type Observable,
  type ObservableCallback,
} from '@opentelemetry/api';

import type { MoveOutcome } from '../movement/players.js';
import {
  CloseCode,
  type ClientMessage,
  type CloseReason,
  type Refusal,
} from '../socket/protocol.js';

/** What the gauges read at each collection. */
type OpenSocket = { cohortId: string; socket: { bufferedAmount: number } };

export interface OpenSockets {
  /** Those standing for an account. */
  all(): readonly OpenSocket[];
  allWatchers(): readonly OpenSocket[];
}

function countByCohort(sockets: readonly OpenSocket[]): Map<string, number> {
  const byCohort = new Map<string, number>();
  for (const { cohortId } of sockets) {
    byCohort.set(cohortId, (byCohort.get(cohortId) ?? 0) + 1);
  }
  return byCohort;
}

/** Why world closed or cut off a socket. */
export type ServerClose = CloseReason | 'heartbeat_missed' | 'not_reading';

export interface WorldMetrics {
  opened(): void;
  refused(reason: Refusal): void;
  /**
   * World's fault, not the client's: the upgrade could not be decided and was
   * closed with `internal_error`, or something threw after the decision and
   * the socket was terminated without a reason.
   */
  failed(): void;
  /** An accepted client was gone before world let it in. */
  abandoned(): void;
  closedByServer(reason: ServerClose): void;
  closed(code: number): void;
  received(type: ClientMessage['type'] | 'invalid'): void;
  moved(outcome: MoveOutcome): void;
  sentFrame(): void;
  /** Stops the gauges reading the sockets. */
  dispose(): void;
}

// World's own codes and the standard ones a closing connection reports. A
// client chooses its code, so any other becomes `other`: otherwise a client
// could mint new series.
const KNOWN_CODES = new Set<number>([
  ...Object.values(CloseCode),
  1000,
  1005,
  1006,
  1009,
]);

/**
 * Counters and gauges for the sockets. Through the OpenTelemetry API, so
 * without a running SDK every instrument is a no-op. What happens per frame
 * or per step is kept as a plain total, a number or a map entry, and read at
 * export, so the hot paths never go through the SDK.
 */
export function worldMetrics(
  sockets: OpenSockets,
  meter: Meter = metrics.getMeter('world'),
): WorldMetrics {
  const observed: [Observable, ObservableCallback][] = [];
  function observe(instrument: Observable, callback: ObservableCallback) {
    instrument.addCallback(callback);
    observed.push([instrument, callback]);
  }

  observe(
    meter.createObservableGauge('world.connections', {
      description: 'Open sockets, by cohort',
    }),
    (result) => {
      for (const [cohortId, count] of countByCohort(sockets.all())) {
        result.observe(count, { cohort_id: cohortId });
      }
    },
  );
  observe(
    meter.createObservableGauge('world.watchers', {
      description:
        'Open sockets watching a cohort without an avatar, by cohort',
    }),
    (result) => {
      for (const [cohortId, count] of countByCohort(sockets.allWatchers())) {
        result.observe(count, { cohort_id: cohortId });
      }
    },
  );
  observe(
    meter.createObservableGauge('world.socket.buffered', {
      description: 'The most any one socket has waiting unsent',
      unit: 'By',
    }),
    (result) => {
      let most = 0;
      for (const { socket } of [...sockets.all(), ...sockets.allWatchers()]) {
        most = Math.max(most, socket.bufferedAmount);
      }
      result.observe(most);
    },
  );

  let framesSent = 0;
  const receivedByType = new Map<string, number>();
  const movesByOutcome = new Map<string, number>();
  observe(meter.createObservableCounter('world.frames.sent'), (result) => {
    result.observe(framesSent);
  });
  observe(
    meter.createObservableCounter('world.messages.received'),
    (result) => {
      for (const [type, count] of receivedByType) {
        result.observe(count, { type });
      }
    },
  );
  observe(meter.createObservableCounter('world.moves'), (result) => {
    for (const [outcome, count] of movesByOutcome) {
      result.observe(count, { outcome });
    }
  });

  const opened = meter.createCounter('world.connections.opened');
  const refused = meter.createCounter('world.connections.refused');
  const failed = meter.createCounter('world.connections.failed');
  const abandoned = meter.createCounter('world.connections.abandoned');
  const closedByServer = meter.createCounter(
    'world.connections.closed_by_server',
  );
  const closed = meter.createCounter('world.connections.closed');

  return {
    opened: () => opened.add(1),
    refused: (reason) => refused.add(1, { reason }),
    failed: () => failed.add(1),
    abandoned: () => abandoned.add(1),
    closedByServer: (reason) => closedByServer.add(1, { reason }),
    closed: (code) =>
      closed.add(1, { code: KNOWN_CODES.has(code) ? code : 'other' }),
    received: (type) =>
      receivedByType.set(type, (receivedByType.get(type) ?? 0) + 1),
    moved: (outcome) =>
      movesByOutcome.set(outcome, (movesByOutcome.get(outcome) ?? 0) + 1),
    sentFrame: () => {
      framesSent += 1;
    },
    dispose: () => {
      for (const [instrument, callback] of observed) {
        instrument.removeCallback(callback);
      }
    },
  };
}
