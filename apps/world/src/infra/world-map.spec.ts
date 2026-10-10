import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { walkable } from '../movement/grid.js';
import { PLACEHOLDER_MAP } from '../movement/world-map.js';
import { fetchEntryMap, loadWorldMap } from './world-map.js';

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

  it('refuses when nothing has been published', async () => {
    await expect(
      fetchEntryMap(sanity, published([], tiled([]))),
    ).rejects.toThrow(/No maps have been published/);
  });

  it('refuses when no project is configured, without asking anybody', async () => {
    const fetcher = vi.fn();

    await expect(
      fetchEntryMap({ ...sanity, SANITY_PROJECT_ID: undefined }, fetcher),
    ).rejects.toThrow(/SANITY_PROJECT_ID/);
    expect(fetcher).not.toHaveBeenCalled();
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

  it('uses the published map in development when there is one', async () => {
    const map = await loadWorldMap(
      { ...sanity, DEPLOYMENT_ENVIRONMENT: 'development' },
      log(),
      published([manifest('campus', true)], tiled([collisions, spawn])),
    );

    expect(map).toMatchObject({ id: 'campus', version: 'campus-v1' });
  });
});
