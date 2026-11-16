import {
  recordingFinder,
  recordingStarter,
  recordingStopper,
  type RecordingEvent,
  type StartedRecording,
} from '@campus/media';

import type { Env } from '../../infra/config/env.js';

/** LiveKit's side of a recording. Its own token so tests can stand in for it. */
export const RECORDING_MEDIA = Symbol('RECORDING_MEDIA');

export interface RecordingMedia {
  /**
   * Starts recording `room` into `fileKey`. Throws `RecordingRefusedError`
   * when LiveKit says no; after any other failure it may have started.
   */
  start(room: string, fileKey: string): Promise<StartedRecording>;
  stop(egressId: string): Promise<void>;
  /** What LiveKit knows of the recording of `room` into `fileKey`, if anything. */
  find(room: string, fileKey: string): Promise<RecordingEvent | null>;
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
    R2_PRIVATE_BUCKET: bucket,
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
    find: recordingFinder(credentials),
  };
}
