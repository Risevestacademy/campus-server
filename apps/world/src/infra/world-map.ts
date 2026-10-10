import {
  ManifestError,
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
import { isDevelopment, type Env } from './env.js';

/** Long enough for a slow answer, short enough that a hung one fails the boot. */
const FETCH_TIMEOUT_MS = 10_000;

type TiledMap = Parameters<typeof readMapLayout>[0];

/**
 * There is no map to load: none configured, none published, or Sanity could
 * not be reached. Apart from every other failure, which is a map that was
 * found and is wrong — that one is never papered over.
 */
export class MapUnavailableError extends Error {}

/** A fetch that gives up, so a request that hangs cannot hang the boot. */
export function withTimeout(
  ms: number = FETCH_TIMEOUT_MS,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return (input, init) =>
    fetcher(input, { ...init, signal: AbortSignal.timeout(ms) });
}

/**
 * Loads the map people enter the campus on, at its current published version.
 * One map only: world has no notion yet of which map somebody is on, so
 * portals and the maps behind them wait for that.
 */
export async function fetchEntryMap(
  env: Pick<Env, 'SANITY_PROJECT_ID' | 'SANITY_DATASET'>,
  fetcher: typeof fetch = withTimeout(),
): Promise<WorldMap> {
  if (!env.SANITY_PROJECT_ID) {
    throw new MapUnavailableError('SANITY_PROJECT_ID is not set');
  }

  // Whether Sanity answered at all is noted here, at the one place every
  // request passes: a request that threw or came back refused is "could not
  // be reached", whatever error the reader then makes of it.
  let unreachable: unknown;
  const reaching: typeof fetch = async (input, init) => {
    let response: Response;
    try {
      response = await fetcher(input, init);
    } catch (err) {
      unreachable = err;
      throw err;
    }
    if (!response.ok) {
      unreachable = new Error(`answered ${response.status}`);
    }
    return response;
  };

  try {
    const manifests = await fetchWorldMapManifests({
      projectId: env.SANITY_PROJECT_ID,
      dataset: env.SANITY_DATASET,
      fetch: reaching,
    });
    const entries = manifests.filter((manifest) => manifest.isEntry);
    if (entries.length !== 1) {
      throw new Error(
        `exactly one published map must be the entry map; found ${entries.length} among ${manifests.map((manifest) => manifest.mapId).join(', ')}`,
      );
    }
    const [manifest] = entries;
    // Only the layout is read, but the published loader is what checks the
    // map is whole, and it is the one campus-web loads the same version
    // through.
    const map = await loadPublishedMap<TiledMap>(manifest, {
      fetch: reaching,
    });
    return {
      id: manifest.mapId,
      version: manifest.version,
      grid: gridFrom(readMapLayout(map)),
    };
  } catch (err) {
    if (unreachable !== undefined) {
      throw new MapUnavailableError('Sanity could not be reached', {
        cause: err,
      });
    }
    if (err instanceof ManifestError && err.message === NOTHING_PUBLISHED) {
      throw new MapUnavailableError(err.message, { cause: err });
    }
    throw err;
  }
}

/**
 * What the package says when the dataset holds no map at all. Matched by its
 * text because the package has one error class for this and for a manifest
 * that is broken; the spec loads an empty dataset through the real package,
 * so a reworded message fails there rather than here.
 */
const NOTHING_PUBLISHED = 'No maps have been published.';

/**
 * The map to run with. Outside development a map that cannot be loaded stops
 * the boot: a world with no walls lets everybody walk through them, and saves
 * positions inside them, which is worse than being down.
 *
 * In development it falls back to the placeholder only when there is no map
 * to load, so world still runs offline or before anything is published. A
 * map that was found and is wrong — no spawn, two entry maps, a layout the
 * reader refuses — stops the boot there too: that is somebody's mistake in
 * the map, and a placeholder would hide it.
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
    if (!isDevelopment(env) || !(err instanceof MapUnavailableError)) {
      throw new Error('could not load the published map', { cause: err });
    }
    log.warn(
      { err },
      'no published map to load: running on the placeholder, with no walls',
    );
    return PLACEHOLDER_MAP;
  }
}
