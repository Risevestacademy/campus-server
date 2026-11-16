import { Writable } from 'node:stream';

/** A pino destination that keeps each line it is given, for a spec to read. */
export function captureLines(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { stream, lines };
}
