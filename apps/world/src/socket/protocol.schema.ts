import { z } from 'zod';

// For its side effect: every schema there with an `id` registers itself in
// zod's global registry, which is what gets written out below.
import './protocol.js';

/**
 * The protocol as one JSON Schema document, for the frontend to generate
 * types from (`json2ts`, `quicktype`, …). Written to protocol.schema.json by
 * `pnpm --filter world protocol:schema`, and checked against the code by the
 * test beside this file, so a change to protocol.ts that forgets to
 * regenerate fails CI instead of reaching the frontend as a surprise.
 *
 * The root is a catalogue, not a message: an object whose properties name
 * every type a client needs, the two message unions and the close codes and
 * reasons. A generator only emits what the root reaches. A root that was the
 * message union reached the messages but not the close lists, and
 * json-schema-to-typescript's --unreachableDefinitions does not help, since
 * it is only read for a root that is an object. This way the default command
 * emits everything, each under its own name, and the message unions are
 * exactly what they were. Every schema in protocol.ts given an `id` becomes
 * a named type; the test beside this file lists which ones, so one appearing
 * or vanishing is noticed. Draft-07 because that is what the common
 * generators read best.
 */
export function protocolJsonSchema(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(z.globalRegistry, {
    target: 'draft-7',
    uri: (id) => `#/definitions/${id}`,
  });

  const definitions: Record<string, unknown> = {};
  for (const [id, schema] of Object.entries(schemas)) {
    // Each comes out as a standalone document; inside `definitions` those
    // two keys would only confuse a generator.
    const {
      $schema: _schema,
      $id: _id,
      ...body
    } = schema as Record<string, unknown>;
    definitions[id] = body;
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'WorldProtocol',
    description:
      'Every type on the world socket. Generated from apps/world/src/socket/protocol.ts; ' +
      'do not edit by hand. This root is a catalogue and is never sent: a frame is a ' +
      'ClientMessage or a ServerMessage, and a close carries a CloseCode and a ' +
      'CloseReason. How to use them — moving, correcting, closing — is in ' +
      'docs/world-protocol.md.',
    type: 'object',
    properties: {
      clientMessage: { $ref: '#/definitions/ClientMessage' },
      serverMessage: { $ref: '#/definitions/ServerMessage' },
      closeCode: { $ref: '#/definitions/CloseCode' },
      closeReason: { $ref: '#/definitions/CloseReason' },
    },
    additionalProperties: false,
    definitions,
  };
}
