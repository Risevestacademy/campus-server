import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { EVENTS, type EventName } from './events.js';

const names = Object.keys(EVENTS) as EventName[];

function fieldsOf(event: EventName): string[] {
  return Object.keys((EVENTS[event].schema as z.ZodObject).shape);
}

describe('the event catalogue', () => {
  const shaped = [
    'ada@example.com',
    'mailto:ada@example.com',
    'https://campus.example/invite?token=abc',
    'Ada Lovelace',
  ];

  it.each(names)(
    '%s admits no email, URL or free text in any field',
    (event) => {
      for (const field of fieldsOf(event)) {
        for (const value of shaped) {
          const result = (EVENTS[event].schema as z.ZodObject).shape[
            field
          ].safeParse(value);
          expect(result.success, `${field} admitted ${value}`).toBe(false);
        }
      }
    },
  );

  it.each(names)('%s refuses a field it does not name', (event) => {
    const result = EVENTS[event].schema.safeParse({ email: 'ada@example.com' });
    expect(result.success).toBe(false);
  });

  it('needs consent only for what describes one person minute by minute', () => {
    const needing = names.filter((event) => EVENTS[event].consent);
    expect(needing).toEqual(['presence.started']);
  });
});
