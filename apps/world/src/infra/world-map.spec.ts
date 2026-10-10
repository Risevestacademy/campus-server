import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { walkable } from '../movement/grid.js';
import { PLACEHOLDER_MAP } from '../movement/world-map.js';
import {
  MapUnavailableError,
  fetchEntryMap,
  loadWorldMap,
  withTimeout,
} from './world-map.js';

const sanity = { SANITY_PROJECT_ID: 'abc123', SANITY_DATASET: 'production' };

const manifest = (mapId: string, isEntry: boolean) => ({
  mapId,
  version: `${mapId}-v1`,
  widthTiles: 4,
  heightTiles: 3,
  isEntry,
  mapUrl: `https://cdn.sanity.io/files/abc123/production/${mapId}.json`,
  tilesets: [],
});

/** 4 × 3 tiles of 32px: one wall in the top-right corner, spawn at (1, 1). */
const tiled = (layers: unknown[]) => ({
  width: 4,
  height: 3,
  tilewidth: 32,
  tileheight: 32,
  tilesets: [],
  layers,
});
const collisions = {
  type: 'objectgroup',
  name: 'collisions',
  objects: [{ id: 1, x: 96, y: 0, width: 32, height: 32 }],
};
const spawn = {
  type: 'objectgroup',
  name: 'spawn',
  objects: [{ id: 2, x: 40, y: 40, point: true }],
};

/** Answers the manifest query with `manifests`, and each map URL with `map`. */
function published(manifests: unknown[], map: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    return new Response(
      JSON.stringify(
        url.includes('/data/query/') ? { result: manifests } : map,
      ),
    );
  }) as typeof fetch;
}

const log = () =>
  ({ info: vi.fn(), warn: vi.fn() }) as unknown as FastifyBaseLogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };

describe('fetchEntryMap', () => {
  it('loads the entry map: its id and version, its spawn and its walls', async () => {
    const map = await fetchEntryMap(
      sanity,
      published(
        [manifest('campus', true), manifest('library', false)],
        tiled([collisions, spawn]),
      ),
    );

    expect(map).toMatchObject({
      id: 'campus',
      version: 'campus-v1',
      grid: { width: 4, height: 3, spawn: { x: 1, y: 1 } },
    });
    expect(walkable(map.grid, { x: 3, y: 0 })).toBe(false);
    expect(walkable(map.grid, { x: 2, y: 0 })).toBe(true);
  });

  it('asks the project and dataset it was given, past the CDN', async () => {
    const asked: string[] = [];
    const answer = published(
      [manifest('campus', true)],
      tiled([collisions, spawn]),
    );

    await fetchEntryMap(
      { SANITY_PROJECT_ID: 'abc123', SANITY_DATASET: 'staging' },
      (async (input: string | URL | Request) => {
        asked.push(String(input));
        return answer(input);
      }) as typeof fetch,
    );

    // Not apicdn: a map published a moment ago must be the one that loads.
    expect(asked[0]).toMatch(
      /^https:\/\/abc123\.api\.sanity\.io\/.*\/data\/query\/staging\?/,
    );
  });

  /** Which map to place people on would otherwise be a guess. */
  it('refuses when no map, or more than one, is the entry map', async () => {
    await expect(
      fetchEntryMap(
        sanity,
        published([manifest('library', false)], tiled([collisions])),
      ),
    ).rejects.toThrow(/exactly one.*found 0/);
    await expect(
      fetchEntryMap(
        sanity,
        published(
          [manifest('campus', true), manifest('library', true)],
          tiled([collisions, spawn]),
        ),
      ),
    ).rejects.toThrow(/exactly one.*found 2/);
  });

  it('refuses an entry map published without a spawn', async () => {
    await expect(
      fetchEntryMap(
        sanity,
        published([manifest('campus', true)], tiled([collisions])),
      ),
    ).rejects.toThrow(/no spawn/);
  });

  /**
   * "No map to load" is its own error, apart from a map that is wrong:
   * development may run without the first and must not hide the second.
   */
  describe('with no map to load', () => {
    it('says so when nothing has been published', async () => {
      await expect(
        fetchEntryMap(sanity, published([], tiled([]))),
      ).rejects.toBeInstanceOf(MapUnavailableError);
    });

    it('says so when no project is configured, without asking anybody', async () => {
      const fetcher = vi.fn();

      await expect(
        fetchEntryMap({ ...sanity, SANITY_PROJECT_ID: undefined }, fetcher),
      ).rejects.toBeInstanceOf(MapUnavailableError);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('says so when Sanity cannot be reached, or refuses', async () => {
      await expect(
        fetchEntryMap(sanity, (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch),
      ).rejects.toBeInstanceOf(MapUnavailableError);
      await expect(
        fetchEntryMap(
          sanity,
          (async () => new Response('', { status: 503 })) as typeof fetch,
        ),
      ).rejects.toBeInstanceOf(MapUnavailableError);
    });

    /** The manifest arrived; it is the map file behind it that is missing. */
    it('says so when the map file cannot be fetched', async () => {
      const answer = published([manifest('campus', true)], tiled([]));

      await expect(
        fetchEntryMap(sanity, (async (input: string | URL | Request) =>
          String(input).includes('/data/query/')
            ? answer(input)
            : new Response('', { status: 404 })) as typeof fetch),
      ).rejects.toBeInstanceOf(MapUnavailableError);
    });

    it('does not say so for a map that was found and is wrong', async () => {
      const wrong = [
        // No spawn.
        published([manifest('campus', true)], tiled([collisions])),
        // No entry map.
        published([manifest('library', false)], tiled([collisions])),
        // A layout the reader refuses: no collisions layer.
        published([manifest('campus', true)], tiled([spawn])),
      ];

      for (const fetcher of wrong) {
        const failure = await fetchEntryMap(sanity, fetcher).catch(
          (err: unknown) => err,
        );
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(MapUnavailableError);
      }
    });
  });
});

describe('withTimeout', () => {
  /** A request that never answers must not keep world from ever starting. */
  it('gives up on a request that hangs', async () => {
    const hanging = ((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason as Error),
        );
      })) as typeof fetch;

    await expect(
      withTimeout(20, hanging)('https://example.com'),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(
      fetchEntryMap(sanity, withTimeout(20, hanging)),
    ).rejects.toBeInstanceOf(MapUnavailableError);
  });

  it('leaves a request that answers alone', async () => {
    const response = await withTimeout(
      1_000,
      (async () => new Response('ok')) as typeof fetch,
    )('https://example.com');

    expect(await response.text()).toBe('ok');
  });
});

describe('loadWorldMap', () => {
  const unreachable = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  /** A world with no walls is worse than one that is down. */
  it('stops the boot outside development when the map cannot be loaded', async () => {
    const logger = log();

    await expect(
      loadWorldMap(
        { ...sanity, DEPLOYMENT_ENVIRONMENT: 'staging' },
        logger,
        unreachable,
      ),
    ).rejects.toThrow(/could not load the published map/);
  });

  it('falls back to the placeholder in development, and says so', async () => {
    const logger = log();

    await expect(
      loadWorldMap(
        { ...sanity, DEPLOYMENT_ENVIRONMENT: 'development' },
        logger,
        unreachable,
      ),
    ).resolves.toBe(PLACEHOLDER_MAP);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('falls back in development when nothing is configured or published', async () => {
    await expect(
      loadWorldMap(
        {
          SANITY_PROJECT_ID: undefined,
          SANITY_DATASET: 'production',
          DEPLOYMENT_ENVIRONMENT: 'development',
        },
        log(),
      ),
    ).resolves.toBe(PLACEHOLDER_MAP);
    await expect(
      loadWorldMap(
        { ...sanity, DEPLOYMENT_ENVIRONMENT: 'development' },
        log(),
        published([], tiled([])),
      ),
    ).resolves.toBe(PLACEHOLDER_MAP);
  });

  /** Somebody's mistake in the map; a placeholder would hide it. */
  it('stops the boot in development too when the published map is wrong', async () => {
    const logger = log();

    await expect(
      loadWorldMap(
        { ...sanity, DEPLOYMENT_ENVIRONMENT: 'development' },
        logger,
        published([manifest('campus', true)], tiled([collisions])),
      ),
    ).rejects.toThrow(/could not load the published map/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  /** Only the word itself, set on purpose, is development. */
  it('does not take an unfamiliar environment for development', async () => {
    for (const name of ['', 'dev', 'Development', 'local']) {
      await expect(
        loadWorldMap(
          { ...sanity, DEPLOYMENT_ENVIRONMENT: name },
          log(),
          unreachable,
        ),
      ).rejects.toThrow(/could not load the published map/);
    }
  });

  it('uses the published map in development when there is one', async () => {
    const map = await loadWorldMap(
      { ...sanity, DEPLOYMENT_ENVIRONMENT: 'development' },
      log(),
      published([manifest('campus', true)], tiled([collisions, spawn])),
    );

    expect(map).toMatchObject({ id: 'campus', version: 'campus-v1' });
  });
});
