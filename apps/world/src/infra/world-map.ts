import {
  fetchWorldMapManifests,
  loadPublishedMap,
  readMapLayout,
} from 'campus-world-map';
import type { FastifyBaseLogger } from 'fastify';

import {
  PLACEHOLDER_MAP,
  gridFrom,
  type WorldMap,
} from '../movement/world-map.js';
import type { Env } from './env.js';

/** Long enough for a slow answer, short enough that a hung one fails the boot. */
const FETCH_TIMEOUT_MS = 10_000;

/** The parts of a Tiled map the layout is read from. */
type TiledMap = Parameters<typeof readMapLayout>[0];

const withTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/**
 * Loads the map people enter the campus on, at its current published version.
 * One map only: world has no notion yet of which map somebody is on, so
 * portals and the maps behind them wait for that.
 */
export async function fetchEntryMap(
  env: Pick<Env, 'SANITY_PROJECT_ID' | 'SANITY_DATASET'>,
  fetcher: typeof fetch = withTimeout,
): Promise<WorldMap> {
  if (!env.SANITY_PROJECT_ID) {
    throw new Error('SANITY_PROJECT_ID is not set');
  }
  const manifests = await fetchWorldMapManifests({
    projectId: env.SANITY_PROJECT_ID,
    dataset: env.SANITY_DATASET,
    fetch: fetcher,
  });
  const entries = manifests.filter((manifest) => manifest.isEntry);
  if (entries.length !== 1) {
    throw new Error(
      `exactly one published map must be the entry map; found ${entries.length} among ${manifests.map((manifest) => manifest.mapId).join(', ')}`,
    );
  }
  const [manifest] = entries;
  // Only the layout is read, but the published loader is what checks the map
  // is whole, and it is the one campus-web loads the same version through.
  const map = await loadPublishedMap<TiledMap>(manifest, { fetch: fetcher });
  const layout = readMapLayout(map);
  return {
    id: manifest.mapId,
    version: manifest.version,
    grid: gridFrom(layout),
  };
}

/**
 * The map to run with. Outside development a map that cannot be loaded stops
 * the boot: a world with no walls lets everybody walk through them, and saves
 * positions inside them, which is worse than being down. In development it
 * falls back to the placeholder, so world still runs offline or before
 * anything is published.
 */
export async function loadWorldMap(
  env: Pick<
    Env,
    'SANITY_PROJECT_ID' | 'SANITY_DATASET' | 'DEPLOYMENT_ENVIRONMENT'
  >,
  log: FastifyBaseLogger,
  fetcher?: typeof fetch,
): Promise<WorldMap> {
  try {
    const map = await fetchEntryMap(env, fetcher);
    log.info(
      {
        mapId: map.id,
        version: map.version,
        width: map.grid.width,
        height: map.grid.height,
      },
      'map loaded',
    );
    return map;
  } catch (err) {
    if (env.DEPLOYMENT_ENVIRONMENT !== 'development') {
      throw new Error('could not load the published map', { cause: err });
    }
    log.warn(
      { err },
      'could not load the published map: running on the placeholder, with no walls',
    );
    return PLACEHOLDER_MAP;
  }
}
