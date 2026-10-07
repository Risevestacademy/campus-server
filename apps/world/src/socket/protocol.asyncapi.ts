import { COHORT_QUERY_PARAM, SESSION_COOKIE, SOCKET_PATH } from './endpoint.js';
import { protocolJsonSchema } from './protocol.schema.js';

/** Where the instance answering is reached, as the request that asked saw it. */
export interface AsyncApiServer {
  host: string;
  /** Whether it was reached over TLS: `wss` if so, `ws` if not. */
  secure: boolean;
}

type JsonObject = Record<string, unknown>;

/**
 * The protocol as an AsyncAPI document: what protocol.schema.json says about
 * each message, plus what it cannot — where the socket is, how to get in, and
 * which way each message travels. For tools that read AsyncAPI: a docs
 * viewer, a type generator, Postman.
 *
 * Nothing here is written twice. The message shapes are the ones
 * protocolJsonSchema() produces from protocol.ts, and the direction of each
 * is read from the two unions there: whatever ClientMessage lists is sent by
 * a client, whatever ServerMessage lists is sent by the server. A message
 * added to protocol.ts appears here on its own, on the right side.
 *
 * AsyncAPI 2.6 rather than 3: it is the version the widest range of tools
 * reads, and the two describe a socket like this one equally well.
 */
export function protocolAsyncApi(server: AsyncApiServer): JsonObject {
  const { definitions } = protocolJsonSchema() as { definitions: JsonObject };
  // The same definitions, moved to where AsyncAPI keeps schemas.
  const schemas = JSON.parse(
    JSON.stringify(definitions).replaceAll(
      '#/definitions/',
      '#/components/schemas/',
    ),
  ) as Record<string, JsonObject>;

  const sentByClient = membersOf(schemas, 'ClientMessage');
  const sentByServer = membersOf(schemas, 'ServerMessage');

  const messages: Record<string, JsonObject> = {};
  for (const name of [...sentByClient, ...sentByServer]) {
    const description = schemas[name]?.description;
    messages[name] = {
      messageId: name,
      name,
      title: name,
      ...(typeof description === 'string' ? { summary: description } : {}),
      contentType: 'application/json',
      payload: { $ref: `#/components/schemas/${name}` },
    };
  }
  const oneOf = (names: readonly string[]) => ({
    oneOf: names.map((name) => ({ $ref: `#/components/messages/${name}` })),
  });

  return {
    asyncapi: '2.6.0',
    info: {
      title: 'Campus world',
      // The protocol carries no version of its own; this document describes
      // whatever the instance serving it is running.
      version: '1.0.0',
      description:
        'The realtime socket behind the campus map: who is here, and where ' +
        'they stand. Generated from apps/world/src/socket/protocol.ts. How to ' +
        'use the messages — moving, correcting a predicted step, what each ' +
        'close code means — is in docs/world-protocol.md.',
    },
    defaultContentType: 'application/json',
    servers: {
      world: {
        url: server.host,
        protocol: server.secure ? 'wss' : 'ws',
        description: 'The instance that served this document.',
        security: [{ session: [] }],
      },
    },
    channels: {
      [SOCKET_PATH]: {
        description:
          'One socket per account, in the cohort it names. The upgrade must ' +
          `carry the \`${SESSION_COOKIE}\` cookie and an \`Origin\` world allows; a ` +
          'refusal arrives as a close code, not an HTTP status.',
        bindings: {
          ws: {
            query: {
              type: 'object',
              required: [COHORT_QUERY_PARAM],
              properties: {
                [COHORT_QUERY_PARAM]: {
                  type: 'string',
                  description: 'The cohort being entered. Required.',
                },
              },
            },
            bindingVersion: '0.1.0',
          },
        },
        // AsyncAPI 2 names operations from the client's side: it publishes
        // what it sends, and subscribes to what it is sent.
        publish: {
          operationId: 'send',
          summary: 'Frames a client sends.',
          message: oneOf(sentByClient),
        },
        subscribe: {
          operationId: 'receive',
          summary: 'Frames the server sends.',
          message: oneOf(sentByServer),
        },
      },
    },
    components: {
      messages,
      schemas,
      securitySchemes: {
        session: {
          type: 'httpApiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description:
            'The session cookie campus-api sets at sign-in. A browser sends ' +
            'it on the upgrade by itself.',
        },
      },
    },
  };
}

/** The messages a union in protocol.ts lists, by name. */
function membersOf(
  schemas: Record<string, JsonObject>,
  union: string,
): string[] {
  const members = schemas[union]?.oneOf;
  if (!Array.isArray(members)) {
    throw new Error(`${union} is not a union of named messages`);
  }
  return members.map((member: { $ref?: unknown }) => {
    if (typeof member.$ref !== 'string') {
      throw new Error(`${union} lists a message with no name`);
    }
    return member.$ref.slice('#/components/schemas/'.length);
  });
}
