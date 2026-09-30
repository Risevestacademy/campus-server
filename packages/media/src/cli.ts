/**
 * Mints a room token by hand, for trying the media server before any product
 * code calls it: `pnpm --filter @campus/media room-token --room spike --identity ada`.
 *
 * Defaults to the local server from docker-compose.local.yml and its dev key
 * pair in livekit.yaml. Point it elsewhere with LIVEKIT_URL, LIVEKIT_API_KEY
 * and LIVEKIT_API_SECRET — all three or none, and never with a production
 * secret pasted on a command line.
 */
import { parseArgs } from 'node:util';

import { InvalidMediaConfigError, mintRoomToken, type MediaCredentials } from './room-token.js';

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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!values.identity) {
  fail(
    'usage: pnpm --filter @campus/media room-token --identity <id> [--room <room>] [--name <name>] [--listen-only]',
  );
}

/**
 * All three from the environment, or the local defaults for all three. A
 * mix — a remote URL with the local key, say — mints a token the server
 * refuses with no hint why, so it is refused here instead. Empty counts as
 * unset, which is what an unfilled line in an env file gives.
 */
function credentialsFromEnv(): MediaCredentials {
  const read = (name: string): string | undefined => process.env[name]?.trim() || undefined;
  const url = read('LIVEKIT_URL');
  const apiKey = read('LIVEKIT_API_KEY');
  const apiSecret = read('LIVEKIT_API_SECRET');

  if (url === undefined && apiKey === undefined && apiSecret === undefined) {
    return LOCAL;
  }
  if (url === undefined || apiKey === undefined || apiSecret === undefined) {
    const missing = [
      url === undefined && 'LIVEKIT_URL',
      apiKey === undefined && 'LIVEKIT_API_KEY',
      apiSecret === undefined && 'LIVEKIT_API_SECRET',
    ].filter(Boolean);
    fail(
      `set all of LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET, or none for the local server; missing: ${missing.join(', ')}`,
    );
  }
  return { url, apiKey, apiSecret };
}

let minted;
try {
  minted = await mintRoomToken(credentialsFromEnv(), {
    room: values.room,
    identity: values.identity,
    name: values.name ?? values.identity,
    canPublish: !values['listen-only'],
  });
} catch (err) {
  if (err instanceof InvalidMediaConfigError) {
    fail(err.message);
  }
  throw err;
}

console.log(`url:     ${minted.url}`);
console.log(`room:    ${minted.room}`);
console.log(`expires: ${minted.expiresAt.toISOString()}`);
console.log(`token:   ${minted.token}`);
console.log('');
console.log('Join from any LiveKit client with the url and token, for example:');
console.log(
  `https://meet.livekit.io/custom?liveKitUrl=${encodeURIComponent(minted.url)}&token=${minted.token}`,
);
