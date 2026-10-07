import { describe, expect, it } from 'vitest';

import { COHORT_QUERY_PARAM, SESSION_COOKIE, SOCKET_PATH } from './endpoint.js';
import { protocolAsyncApi } from './protocol.asyncapi.js';
import { protocolJsonSchema } from './protocol.schema.js';

type Json = Record<string, any>;

const document = protocolAsyncApi({
  host: 'ws.campus.example',
  secure: true,
}) as Json;
const namesIn = (operation: Json): string[] =>
  operation.message.oneOf.map((ref: { $ref: string }) =>
    ref.$ref.replace('#/components/messages/', ''),
  );

describe('the AsyncAPI document', () => {
  it('says where the socket is and how to get in', () => {
    expect(document.asyncapi).toBe('2.6.0');
    expect(document.servers.world).toMatchObject({
      url: 'ws.campus.example',
      protocol: 'wss',
      security: [{ session: [] }],
    });
    expect(document.components.securitySchemes.session).toMatchObject({
      type: 'httpApiKey',
      in: 'cookie',
      name: 'campus_session',
    });
    expect(document.channels['/socket'].bindings.ws.query.required).toEqual([
      'cohortId',
    ]);
  });

  // The document repeats nothing about the connection: the path, the
  // parameter and the cookie are the values the gateway itself enforces.
  it('names the path, parameter and cookie the gateway uses', () => {
    const channel = document.channels[SOCKET_PATH];

    expect(Object.keys(document.channels)).toEqual([SOCKET_PATH]);
    expect(channel.bindings.ws.query.required).toEqual([COHORT_QUERY_PARAM]);
    expect(Object.keys(channel.bindings.ws.query.properties)).toEqual([
      COHORT_QUERY_PARAM,
    ]);
    expect(channel.description).toContain(SESSION_COOKIE);
    expect(document.components.securitySchemes.session.name).toBe(
      SESSION_COOKIE,
    );
  });

  it('describes a plain connection as ws', () => {
    expect(
      (protocolAsyncApi({ host: 'localhost:3001', secure: false }) as Json)
        .servers.world,
    ).toMatchObject({ url: 'localhost:3001', protocol: 'ws' });
  });

  // The point of the document over the plain schema: which way each message
  // travels. Read from the unions in protocol.ts, so it cannot be wrong
  // about a message without protocol.ts being wrong about it too.
  it('puts every message on the side that sends it', () => {
    const { publish, subscribe } = document.channels['/socket'];

    expect(namesIn(publish)).toEqual(['PingMessage', 'MoveMessage']);
    expect(namesIn(subscribe)).toEqual([
      'WelcomeMessage',
      'PongMessage',
      'SnapshotMessage',
      'JoinedMessage',
      'LeftMessage',
      'ReplacedMessage',
      'MovedMessage',
      'MoveResultMessage',
      'ErrorMessage',
    ]);
  });

  it('carries the same shapes the schema does, under its own paths', () => {
    const { definitions } = protocolJsonSchema() as Json;

    expect(Object.keys(document.components.schemas).sort()).toEqual(
      Object.keys(definitions).sort(),
    );
    expect(JSON.stringify(document)).not.toContain('#/definitions/');
    expect(document.components.schemas.MoveMessage.properties.type).toEqual(
      definitions.MoveMessage.properties.type,
    );
  });

  it('points only at things it contains', () => {
    const refs = [
      ...JSON.stringify(document).matchAll(/"\$ref":"#\/([^"]+)"/g),
    ].map((match) => match[1].split('/'));

    expect(refs.length).toBeGreaterThan(0);
    for (const path of refs) {
      const target = path.reduce<unknown>(
        (node, key) => (node as Json | undefined)?.[key],
        document,
      );
      expect(target, path.join('/')).toBeDefined();
    }
  });

  it('gives each message a name, a summary and a payload', () => {
    for (const [name, message] of Object.entries<Json>(
      document.components.messages,
    )) {
      expect(message).toMatchObject({
        messageId: name,
        name,
        payload: { $ref: `#/components/schemas/${name}` },
      });
      expect(message.summary, name).toEqual(expect.any(String));
    }
  });
});
