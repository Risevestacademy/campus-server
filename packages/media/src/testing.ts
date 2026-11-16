import { createHash } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';

import type { MediaCredentials } from './room-token.js';

/** The Authorization header LiveKit would send with `body`. For tests and local tools only. */
export async function signCallWebhook(
  keys: Pick<MediaCredentials, 'apiKey' | 'apiSecret'>,
  body: string,
): Promise<string> {
  const token = new AccessToken(keys.apiKey, keys.apiSecret);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}
