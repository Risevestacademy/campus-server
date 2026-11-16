import type { WebSocket } from 'ws';

/** What `deliver` needs of a socket, so it can be tested without one. */
export type Outbound = Pick<
  WebSocket,
  'readyState' | 'OPEN' | 'bufferedAmount' | 'send' | 'terminate'
>;

/**
 * - `sent`: queued on the socket.
 * - `closed`: the socket is not open; nothing to do.
 * - `lagging`: the client is not reading; the socket has been terminated.
 */
export type Delivery = 'sent' | 'closed' | 'lagging';

/**
 * Sends one frame, unless the client has stopped reading what it was already
 * sent.
 *
 * A socket whose client does not read keeps everything sent to it in this
 * process's memory, and movement is sent every tick whether anybody reads it
 * or not — so one stalled tab would grow without limit. Past
 * `maxBufferedBytes` it is cut off.
 *
 * Cut off rather than skipped: dropping frames would leave that client
 * believing people stand where they no longer do, with nothing to tell it
 * so. Disconnected, it reconnects and starts again from a fresh snapshot.
 *
 * terminate, not close: a close frame would queue behind everything the
 * client is not reading, and never arrive. The close event still follows,
 * asynchronously, so the socket leaves through the usual path — after
 * whatever broadcast is in progress has finished, so nobody is told somebody
 * left in the middle of a frame that still lists them.
 */
export function deliver(
  ws: Outbound,
  frame: string,
  maxBufferedBytes: number,
): Delivery {
  if (ws.readyState !== ws.OPEN) {
    return 'closed';
  }
  if (ws.bufferedAmount > maxBufferedBytes) {
    ws.terminate();
    return 'lagging';
  }
  ws.send(frame);
  return 'sent';
}
