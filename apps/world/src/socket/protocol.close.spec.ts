import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CLOSES, CloseCode, REFUSALS, type CloseReason } from './protocol.js';
import { protocolJsonSchema } from './protocol.schema.js';

const definitions = () =>
  (protocolJsonSchema() as { definitions: Record<string, unknown> })
    .definitions;

/** The `const` values of a union of literals, as the schema writes them. */
const constsOf = (schema: unknown) =>
  ((schema as { anyOf: { const: unknown }[] }).anyOf ?? []).map(
    (member) => member.const,
  );

describe('close codes and reasons', () => {
  /**
   * The web client decides what to do from the close event, and generates
   * the reasons from the schema rather than copying them. So every reason
   * world closes with has to be in it, and nothing else.
   */
  it('puts every close reason in the schema, each with its code and what to do', () => {
    const schema = definitions().CloseReason as {
      anyOf: { const: string; description: string }[];
    };

    expect(constsOf(schema).sort()).toEqual(Object.keys(CLOSES).sort());
    for (const member of schema.anyOf) {
      const close = CLOSES[member.const as CloseReason];
      expect(member.description).toContain(`Close ${close.code}.`);
      expect(member.description).toContain(close.action);
    }
  });

  it('puts every close code world sends in the schema', () => {
    expect(constsOf(definitions().CloseCode).sort()).toEqual(
      Object.values(CloseCode).sort(),
    );
  });

  it('refuses an upgrade only with reasons on the list, all of them 1008', () => {
    for (const refusal of REFUSALS) {
      expect(CLOSES[refusal].code).toBe(CloseCode.PolicyViolation);
    }
  });

  /**
   * The protocol doc's close table is what people read, so it is held to
   * the list here word for word: one row per reason, with its code, what it
   * means and what to do. A reason added, renamed, or given a new meaning or
   * action in code without the doc fails this test rather than leaving the
   * doc saying something else. Rows with no reason (1006, 1009) come from the
   * browser and the socket library, and are the doc's alone.
   */
  it('matches the close table in docs/world-protocol.md, row for row', () => {
    const doc = readFileSync(
      fileURLToPath(
        new URL('../../../../docs/world-protocol.md', import.meta.url),
      ),
      'utf8',
    );
    const table = doc.slice(doc.indexOf('## Errors and closing'));
    /** Markdown dressing and padding away, so only the words are compared. */
    const plain = (text: string) =>
      text.replaceAll('`', '').replaceAll('**', '').replace(/\s+/g, ' ').trim();

    const documented: Record<string, unknown> = {};
    for (const line of table.split('\n')) {
      const cells = /^\| (\d{4}) \|(.*)\|$/.exec(line);
      if (!cells) continue;
      const [reason, meaning, action] = cells[2].split('|').map(plain);
      if (reason === '—') continue;
      expect(documented, `${reason} has more than one row`).not.toHaveProperty([
        reason,
      ]);
      documented[reason] = { code: Number(cells[1]), meaning, action };
    }

    expect(documented).toEqual(
      Object.fromEntries(
        Object.entries(CLOSES).map(([reason, close]) => [
          reason,
          {
            code: close.code,
            meaning: plain(close.meaning),
            action: plain(close.action),
          },
        ]),
      ),
    );
  });
});
