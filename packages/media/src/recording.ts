import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
  type EgressInfo,
} from 'livekit-server-sdk';

import { assertMediaCredentials, type MediaCredentials } from './room-token.js';

/** A private Cloudflare R2 bucket, reached through its S3 API. */
export interface RecordingStore {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function recordingStoreEndpoint({
  accountId,
}: Pick<RecordingStore, 'accountId'>): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function egressClient(credentials: MediaCredentials): EgressClient {
  assertMediaCredentials(credentials);
  // Failover would send a start that got no answer to another region, which
  // could start a second recording of the room.
  return new EgressClient(
    credentials.url.replace(/^ws(s?):\/\//, 'http$1://'),
    credentials.apiKey,
    credentials.apiSecret,
    { failover: false },
  );
}

/** LiveKit answered a start and would not do it: nothing was started. */
export class RecordingRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RecordingRefusedError';
  }
}

export interface StartedRecording {
  egressId: string;
  /** LiveKit's id for the run of the room being recorded. */
  roomId: string | null;
}

/**
 * Records a whole room into one MP4, uploaded by LiveKit straight to the
 * bucket under `fileKey`. Throws `RecordingRefusedError` when LiveKit says
 * no; any other failure leaves it unknown whether the recording started.
 */
export function recordingStarter(
  credentials: MediaCredentials,
  store: RecordingStore,
): (room: string, fileKey: string) => Promise<StartedRecording> {
  const client = egressClient(credentials);
  return async (room, fileKey) => {
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: fileKey,
      disableManifest: true,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: store.accessKeyId,
          secret: store.secretAccessKey,
          region: 'auto',
          endpoint: recordingStoreEndpoint(store),
          bucket: store.bucket,
          forcePathStyle: true,
        }),
      },
    });
    let info: EgressInfo;
    try {
      info = await client.startRoomCompositeEgress(room, output, {
        layout: 'grid',
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500) {
        throw new RecordingRefusedError((err as Error).message, status);
      }
      throw err;
    }
    return { egressId: info.egressId, roomId: info.roomId || null };
  };
}

/**
 * What LiveKit knows of the recording of `room` into `fileKey`, or null if
 * it knows of none. One still going is preferred to one that is over.
 */
export function recordingFinder(
  credentials: MediaCredentials,
): (room: string, fileKey: string) => Promise<RecordingEvent | null> {
  const client = egressClient(credentials);
  return async (room, fileKey) => {
    const found = (await client.listEgress({ roomName: room }))
      .filter((info) => fileKeyOf(info) === fileKey)
      .map(readRecordingEvent)
      .filter((event): event is RecordingEvent => event !== null);
    return found.find((event) => event.state === 'active') ?? found[0] ?? null;
  };
}

/** Stops a recording. One already over, or unknown to LiveKit, is not an error. */
export function recordingStopper(
  credentials: MediaCredentials,
): (egressId: string) => Promise<void> {
  const client = egressClient(credentials);
  return async (egressId) => {
    try {
      await client.stopEgress(egressId);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 412) return;
      throw err;
    }
  };
}

export type RecordingState = 'active' | 'complete' | 'failed';

export interface RecordingEvent {
  kind: 'recording_updated';
  egressId: string;
  room: string;
  /** LiveKit's id for the run of the room it records. */
  roomId: string | null;
  /** The file key the recording was started with, which names our row. */
  fileKey: string | null;
  state: RecordingState | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  sizeBytes: number | null;
  error: string | null;
}

function state(info: EgressInfo): RecordingState | null {
  switch (info.status) {
    case EgressStatus.EGRESS_ACTIVE:
    case EgressStatus.EGRESS_ENDING:
      return 'active';
    case EgressStatus.EGRESS_COMPLETE:
      return 'complete';
    // Stopped at LiveKit's length limit: what was recorded is still saved.
    case EgressStatus.EGRESS_LIMIT_REACHED:
      return info.fileResults[0]?.location ? 'complete' : 'failed';
    case EgressStatus.EGRESS_FAILED:
    case EgressStatus.EGRESS_ABORTED:
      return 'failed';
    default:
      return null;
  }
}

function fileKeyOf(info: EgressInfo): string | null {
  const request = info.request;
  if (request.case !== 'roomComposite') return null;
  const [file] = request.value.fileOutputs;
  if (file?.filepath) return file.filepath;
  const legacy = request.value.output;
  return legacy.case === 'file' ? legacy.value.filepath || null : null;
}

function nanos(value: bigint): Date | null {
  return value ? new Date(Number(value / 1_000_000n)) : null;
}

/** Reads an egress webhook's `egressInfo` into plain values. */
export function readRecordingEvent(info: EgressInfo): RecordingEvent | null {
  if (!info.egressId || !info.roomName) return null;
  const [file] = info.fileResults;
  return {
    kind: 'recording_updated',
    egressId: info.egressId,
    room: info.roomName,
    roomId: info.roomId || null,
    fileKey: fileKeyOf(info),
    state: state(info),
    startedAt: nanos(info.startedAt),
    endedAt: nanos(info.endedAt),
    durationMs: file?.duration ? Number(file.duration / 1_000_000n) : null,
    sizeBytes: file?.size ? Number(file.size) : null,
    error: info.error || null,
  };
}
