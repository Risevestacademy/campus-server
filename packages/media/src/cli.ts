/**
 * Mints a room token by hand, for trying the media server before any product
 * code calls it: `pnpm --filter @campus/media room-token --room spike --identity ada`.
 *
 * Defaults to the local server from docker-compose.local.yml and its dev key
 * pair in livekit.yaml. Point it elsewhere with LIVEKIT_URL, LIVEKIT_API_KEY
 * and LIVEKIT_API_SECRET — never with a production secret pasted on a
 * command line.
 */
import { parseArgs } from 'node:util';

import { mintRoomToken, type MediaCredentials } from './room-token.js';

const LOCAL: MediaCredentials = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'local-dev-secret-not-for-production-use',
};

const { values } = parseArgs({
  options: {
    room: { type: 'string', default: 'spike' },
    identity: { type: 'string' },
    name: { type: 'string' },
    'listen-only': { type: 'boolean', default: false },
  },
});

if (!values.identity) {
  console.error(
    'usage: pnpm --filter @campus/media room-token --identity <id> [--room <room>] [--name <name>] [--listen-only]',
  );
  process.exit(1);
}

const credentials: MediaCredentials = {
  url: process.env.LIVEKIT_URL ?? LOCAL.url,
  apiKey: process.env.LIVEKIT_API_KEY ?? LOCAL.apiKey,
  apiSecret: process.env.LIVEKIT_API_SECRET ?? LOCAL.apiSecret,
};

const minted = await mintRoomToken(credentials, {
  room: values.room,
  identity: values.identity,
  name: values.name ?? values.identity,
  canPublish: !values['listen-only'],
});

console.log(`url:     ${minted.url}`);
console.log(`room:    ${minted.room}`);
console.log(`expires: ${minted.expiresAt.toISOString()}`);
console.log(`token:   ${minted.token}`);
console.log('');
console.log('Join from any LiveKit client with the url and token, for example:');
console.log(
  `https://meet.livekit.io/custom?liveKitUrl=${encodeURIComponent(minted.url)}&token=${minted.token}`,
);
