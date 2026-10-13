import { Inject, Injectable } from '@nestjs/common';
import {
  LayoutError,
  ManifestError,
  checkLinks,
  fetchWorldMapManifests,
  loadPublishedMap,
  readMapLayout,
  type MapLayout,
} from 'campus-world-map';

import { CONFIG } from '../../infra/config/config.constants.js';
import type { Env } from '../../infra/config/env.js';
import {
  PublishedMapsRejectedException,
  PublishedMapsUnavailableException,
} from './maps.exceptions.js';
import { DEFAULT_SPACE_KEY } from './space-defaults.js';

/** Injection token for the fetch the published maps are read with. */
export const MAPS_FETCH = Symbol('MAPS_FETCH');

/** Long enough for a slow answer, short enough that a hung one fails the sync. */
const FETCH_TIMEOUT_MS = 10_000;

/** fetch, giving up: a request that hangs must not hang an admin's request. */
export const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

type TiledMap = Parameters<typeof readMapLayout>[0];

/** One map as it is published now: which, at what version, and what is on it. */
export interface PublishedMap {
  /** The map's ID in Sanity, which is its key here. */
  key: string;
  version: string;
  isEntry: boolean;
  spaces: PublishedSpace[];
}

/** A space as the map draws it. Where it is stays with the map. */
export interface PublishedSpace {
  key: string;
  name: string;
  /** The class the designer gave it in Tiled. A suggestion, and often blank. */
  tiledClass: string | null;
}

const KEY_MAX = 64;
const NAME_MAX = 128;

/**
 * Reads the campus maps as they are published now, and refuses them unless
 * they could be adopted whole.
 *
 * It reads the latest version of every map in one go, with the same package
 * and the same checks the publisher ran, so what comes back is a set that
 * fits together. Then it checks the few things only this side cares about:
 * that every key fits its column, and that no drawn space has taken the key
 * kept for a map's default space.
 *
 * Nothing here writes. Reading first, and whole, is what lets the sync change
 * nothing at all when what is published is not fit to adopt.
 */
@Injectable()
export class PublishedMapsReader {
  constructor(
    @Inject(CONFIG) private readonly config: Env,
    @Inject(MAPS_FETCH) private readonly fetcher: typeof fetch,
  ) {}

  async read(): Promise<PublishedMap[]> {
    const projectId = this.config.SANITY_PROJECT_ID;
    if (!projectId) {
      throw new PublishedMapsUnavailableException(
        'Maps are not set up on this deployment.',
        { reason: 'not_configured' },
      );
    }

    // Whether Sanity answered at all is noted here, at the one place every
    // request passes: a request that threw or came back refused is "could
    // not be reached", whatever error the reader then makes of it.
    let unreachable = false;
    const reaching: typeof fetch = async (input, init) => {
      let response: Response;
      try {
        response = await this.fetcher(input, init);
      } catch (err) {
        unreachable = true;
        throw err;
      }
      if (!response.ok) {
        unreachable = true;
      }
      return response;
    };

    let loaded: { key: string; version: string; layout: MapLayout }[];
    try {
      const manifests = await fetchWorldMapManifests({
        projectId,
        dataset: this.config.SANITY_DATASET,
        fetch: reaching,
      });
      loaded = await Promise.all(
        manifests.map(async (manifest) => ({
          key: manifest.mapId,
          version: manifest.version,
          layout: readMapLayout(
            (await loadPublishedMap(manifest, { fetch: reaching })) as TiledMap,
          ),
        })),
      );
    } catch (err) {
      if (unreachable) {
        throw new PublishedMapsUnavailableException(
          'The published maps could not be reached. Try again shortly.',
          { reason: 'unreachable' },
        );
      }
      if (err instanceof LayoutError || err instanceof ManifestError) {
        throw new PublishedMapsRejectedException(
          'The published maps cannot be adopted as they are.',
          err.message
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        );
      }
      throw err;
    }

    const problems = [
      ...checkLinks(new Map(loaded.map((map) => [map.key, map.layout]))),
      ...loaded.flatMap((map) => fitProblems(map.key, map.layout)),
    ];
    if (problems.length > 0) {
      throw new PublishedMapsRejectedException(
        'The published maps cannot be adopted as they are.',
        problems,
      );
    }

    return loaded.map(({ key, version, layout }) => ({
      key,
      version,
      // The map people enter on is the one with a spawn; checkLinks has just
      // made sure there is exactly one.
      isEntry: layout.spawn !== null,
      spaces: layout.spaces.map((space) => ({
        key: space.key,
        name: space.name,
        tiledClass: space.kind,
      })),
    }));
  }
}

/** What stops a map's rows being written, which the publisher does not check. */
function fitProblems(mapKey: string, layout: MapLayout): string[] {
  const problems: string[] = [];
  if (mapKey.length > KEY_MAX) {
    problems.push(
      `Map "${mapKey}" has an ID longer than ${KEY_MAX} characters.`,
    );
  }
  for (const space of layout.spaces) {
    if (space.key === DEFAULT_SPACE_KEY) {
      problems.push(
        `Space "${space.key}" on "${mapKey}" uses a name kept for the map's own default space. Rename it in Tiled.`,
      );
    }
    if (space.key.length > KEY_MAX) {
      problems.push(
        `Space "${space.key}" on "${mapKey}" has a name longer than ${KEY_MAX} characters.`,
      );
    }
    if (space.name.length > NAME_MAX) {
      problems.push(
        `Space "${space.key}" on "${mapKey}" has a display name longer than ${NAME_MAX} characters.`,
      );
    }
  }
  return problems;
}
