import { recordingStarter, recordingStopper } from '@campus/media';

import type { Env } from '../../infra/config/env.js';

/** LiveKit's side of a recording. Its own token so tests can stand in for it. */
export const RECORDING_MEDIA = Symbol('RECORDING_MEDIA');

export interface RecordingMedia {
  /** Starts recording `room` into `fileKey`; resolves to LiveKit's id for it. */
  start(room: string, fileKey: string): Promise<string>;
  stop(egressId: string): Promise<void>;
}

/** Null unless every recording variable is set. */
export function recordingMediaFrom(config: Env): RecordingMedia | null {
  const {
    LIVEKIT_URL: url,
    LIVEKIT_WEBHOOK_API_KEY: apiKey,
    LIVEKIT_WEBHOOK_API_SECRET: apiSecret,
    R2_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
    R2_BUCKET: bucket,
  } = config;
  if (
    !url ||
    !apiKey ||
    !apiSecret ||
    !accountId ||
    !accessKeyId ||
    !secretAccessKey ||
    !bucket
  ) {
    return null;
  }
  const credentials = { url, apiKey, apiSecret };
  return {
    start: recordingStarter(credentials, {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket,
    }),
    stop: recordingStopper(credentials),
  };
}
