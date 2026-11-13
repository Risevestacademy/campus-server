import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { verifyCallWebhook } from './calls.js';
import {
  RecordingRefusedError,
  recordingFinder,
  recordingStarter,
  recordingStopper,
} from './recording.js';
import { signCallWebhook } from './testing.js';

const ROOM =
  'space:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const KEYS = { apiKey: 'webhook-key', apiSecret: 'w'.repeat(32) };
const STORE = {
  accountId: 'acc123',
  accessKeyId: 'r2-key',
  secretAccessKey: 'r2-secret',
  bucket: 'campus-recordings',
};

/** Stands in for LiveKit's egress API, answering each call with `status` and `reply`. */
async function livekit(status = 200, reply: object = { egressId: 'EG_1' }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      calls.push({
        path: request.url ?? '',
        body: JSON.parse(body) as Record<string, unknown>,
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          status === 200 ? reply : { code: 'failed_precondition', msg: 'no' },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const credentials = {
    url: `ws://127.0.0.1:${port}`,
    apiKey: 'devkey',
    apiSecret: 'a-livekit-secret-of-at-least-32-chars',
  };
  return {
    calls,
    credentials,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('recordingStarter', () => {
  it('records the whole room as one MP4 uploaded straight to the bucket', async () => {
    const api = await livekit();

    const started = await recordingStarter(api.credentials, STORE)(
      ROOM,
      'recordings/a.mp4',
    );

    expect(started).toEqual({ egressId: 'EG_1', roomId: null });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].path).toContain('StartRoomCompositeEgress');
    expect(api.calls[0].body).toMatchObject({
      roomName: ROOM,
      layout: 'grid',
      fileOutputs: [
        {
          fileType: 'MP4',
          filepath: 'recordings/a.mp4',
          disableManifest: true,
          s3: {
            accessKey: 'r2-key',
            secret: 'r2-secret',
            region: 'auto',
            endpoint: 'https://acc123.r2.cloudflarestorage.com',
            bucket: 'campus-recordings',
            forcePathStyle: true,
          },
        },
      ],
    });
    await api.close();
  });

  it('names the run of the room it records', async () => {
    const api = await livekit(200, { egressId: 'EG_1', roomId: 'RM_1' });

    await expect(
      recordingStarter(api.credentials, STORE)(ROOM, 'recordings/a.mp4'),
    ).resolves.toEqual({ egressId: 'EG_1', roomId: 'RM_1' });
    await api.close();
  });

  it('tells a refusal from a failure that may have started it', async () => {
    const refused = await livekit(412);
    await expect(
      recordingStarter(refused.credentials, STORE)(ROOM, 'recordings/a.mp4'),
    ).rejects.toBeInstanceOf(RecordingRefusedError);
    await refused.close();

    const broken = await livekit(503);
    const failure = recordingStarter(broken.credentials, STORE)(
      ROOM,
      'recordings/a.mp4',
    );
    await expect(failure).rejects.toThrow();
    await expect(failure).rejects.not.toBeInstanceOf(RecordingRefusedError);
    expect(broken.calls).toHaveLength(1);
    await broken.close();
  });
});

describe('recordingFinder', () => {
  const egress = (egressId: string, filepath: string, status: string) => ({
    egressId,
    roomId: 'RM_1',
    roomName: ROOM,
    status,
    roomComposite: { roomName: ROOM, fileOutputs: [{ filepath }] },
  });

  it('finds the room’s recording into a file, preferring one still going', async () => {
    const api = await livekit(200, {
      items: [
        egress('EG_1', 'recordings/a.mp4', 'EGRESS_FAILED'),
        egress('EG_2', 'recordings/a.mp4', 'EGRESS_ACTIVE'),
        egress('EG_3', 'recordings/b.mp4', 'EGRESS_ACTIVE'),
      ],
    });

    const found = await recordingFinder(api.credentials)(
      ROOM,
      'recordings/a.mp4',
    );

    expect(api.calls[0].path).toContain('ListEgress');
    expect(api.calls[0].body).toMatchObject({ roomName: ROOM });
    expect(found).toMatchObject({
      egressId: 'EG_2',
      roomId: 'RM_1',
      state: 'active',
    });
    await api.close();
  });

  it('finds nothing where LiveKit knows of no such recording', async () => {
    const api = await livekit(200, { items: [] });

    await expect(
      recordingFinder(api.credentials)(ROOM, 'recordings/a.mp4'),
    ).resolves.toBeNull();
    await api.close();
  });
});

describe('recordingStopper', () => {
  it('stops a recording by its id', async () => {
    const api = await livekit();

    await recordingStopper(api.credentials)('EG_1');

    expect(api.calls[0].path).toContain('StopEgress');
    expect(api.calls[0].body).toEqual({ egressId: 'EG_1' });
    await api.close();
  });

  it('takes a recording already over as stopped', async () => {
    const api = await livekit(412);

    await expect(
      recordingStopper(api.credentials)('EG_1'),
    ).resolves.toBeUndefined();
    await api.close();
  });

  it('passes on any other failure', async () => {
    const api = await livekit(500);

    await expect(recordingStopper(api.credentials)('EG_1')).rejects.toThrow();
    await api.close();
  });
});

describe('a recording’s webhook', () => {
  async function verify(egressInfo: object, event = 'egress_ended') {
    const body = JSON.stringify({
      event,
      id: 'EV_1',
      createdAt: '1792500000',
      egressInfo,
    });
    return verifyCallWebhook(KEYS, body, await signCallWebhook(KEYS, body));
  }

  const info = {
    egressId: 'EG_1',
    roomId: 'RM_1',
    roomName: ROOM,
    roomComposite: {
      roomName: ROOM,
      fileOutputs: [{ filepath: 'recordings/a.mp4' }],
    },
  };

  it('reads a finished recording: its file, length and size', async () => {
    const verified = await verify({
      ...info,
      status: 'EGRESS_COMPLETE',
      startedAt: '1792500000000000000',
      endedAt: '1792503600000000000',
      fileResults: [
        {
          filename: 'recordings/a.mp4',
          duration: '3600000000000',
          size: '1073741824',
          location: 'https://acc123.r2.cloudflarestorage.com/recordings/a.mp4',
        },
      ],
    });

    expect(verified.event).toBeNull();
    expect(verified.recording).toEqual({
      kind: 'recording_updated',
      egressId: 'EG_1',
      room: ROOM,
      roomId: 'RM_1',
      fileKey: 'recordings/a.mp4',
      state: 'complete',
      startedAt: new Date(1_792_500_000_000),
      endedAt: new Date(1_792_503_600_000),
      durationMs: 3_600_000,
      sizeBytes: 1_073_741_824,
      error: null,
    });
  });

  it('reads a recording under way as active', async () => {
    const verified = await verify(
      { ...info, status: 'EGRESS_ACTIVE', startedAt: '1792500000000000000' },
      'egress_started',
    );

    expect(verified.recording).toMatchObject({
      state: 'active',
      endedAt: null,
      durationMs: null,
    });
  });

  it('reads a failure with LiveKit’s reason', async () => {
    const verified = await verify({
      ...info,
      status: 'EGRESS_FAILED',
      error: 'upload failed',
    });

    expect(verified.recording).toMatchObject({
      state: 'failed',
      error: 'upload failed',
    });
  });

  it('keeps what was saved when LiveKit’s length limit stopped it', async () => {
    const saved = await verify({
      ...info,
      status: 'EGRESS_LIMIT_REACHED',
      fileResults: [{ location: 'https://x/recordings/a.mp4' }],
    });
    const lost = await verify({ ...info, status: 'EGRESS_LIMIT_REACHED' });

    expect(saved.recording?.state).toBe('complete');
    expect(lost.recording?.state).toBe('failed');
  });

  it('reads no recording from an event that is not about one', async () => {
    const body = JSON.stringify({
      event: 'room_started',
      id: 'EV_2',
      createdAt: '1792500000',
      room: { name: ROOM, sid: 'RM_1' },
    });

    const verified = await verifyCallWebhook(
      KEYS,
      body,
      await signCallWebhook(KEYS, body),
    );

    expect(verified.recording).toBeNull();
  });
});
