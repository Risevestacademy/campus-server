import { describe, expect, it, vi } from 'vitest';

import { deliver, type Outbound } from './outbound.js';

const OPEN = 1;
const CLOSING = 2;

function socket(bufferedAmount: number, readyState = OPEN) {
  return {
    OPEN,
    readyState,
    bufferedAmount,
    send: vi.fn(),
    terminate: vi.fn(),
  } as unknown as Outbound & {
    send: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
}

describe('deliver', () => {
  it('sends to a client that is keeping up', () => {
    const ws = socket(500);

    expect(deliver(ws, 'frame', 1_000)).toBe('sent');
    expect(ws.send).toHaveBeenCalledWith('frame');
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('allows a backlog up to the limit', () => {
    const ws = socket(1_000);

    expect(deliver(ws, 'frame', 1_000)).toBe('sent');
  });

  /** Anything more would sit in this process's memory, growing every tick. */
  it('cuts off a client that has stopped reading, instead of queueing more', () => {
    const ws = socket(1_001);

    expect(deliver(ws, 'frame', 1_000)).toBe('lagging');
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('does nothing to a socket that is already closing', () => {
    const ws = socket(10_000, CLOSING);

    expect(deliver(ws, 'frame', 1_000)).toBe('closed');
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });
});
