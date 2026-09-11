import { gracefulShutdown } from './shutdown.js';

describe('gracefulShutdown', () => {
  it('closes the app before shutting down other resources', async () => {
    const calls: string[] = [];
    const app = {
      close: async () => {
        calls.push('app.close');
      },
    };

    await gracefulShutdown(app, [
      async () => {
        calls.push('resource-a');
      },
      async () => {
        calls.push('resource-b');
      },
    ]);

    expect(calls[0]).toBe('app.close');
    expect(calls).toContain('resource-a');
    expect(calls).toContain('resource-b');
  });

  it('runs remaining resource shutdowns even if one rejects', async () => {
    const app = { close: async () => undefined };
    const second = vi.fn(async () => undefined);

    await gracefulShutdown(app, [async () => Promise.reject(new Error('fail')), second]);

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('still shuts down resources if app.close itself rejects', async () => {
    const app = { close: async () => Promise.reject(new Error('close failed')) };
    const resource = vi.fn(async () => undefined);

    await gracefulShutdown(app, [resource]);

    expect(resource).toHaveBeenCalledTimes(1);
  });

  it('shuts down resources when app is undefined', async () => {
    const resource = vi.fn(async () => undefined);

    await gracefulShutdown(undefined, [resource]);

    expect(resource).toHaveBeenCalledTimes(1);
  });

  it('proceeds to shut down resources if app.close hangs past the timeout', async () => {
    const app = { close: () => new Promise(() => {}) };
    const resource = vi.fn(async () => undefined);

    await gracefulShutdown(app, [resource], 20);

    expect(resource).toHaveBeenCalledTimes(1);
  });
});
