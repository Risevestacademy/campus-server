/**
 * Stand-ins for what the Studio publishes to Sanity: Tiled maps built in
 * code, and a `fetch` that answers for Sanity with them. So a test reads
 * "published" maps through the real campus-world-map package, with no
 * network.
 */

export interface DrawnSpace {
  /** The object's name in Tiled: the space's key. */
  key: string;
  /** The `name` property: what it is called. Defaults to the key. */
  name?: string;
  /** The object's class in Tiled: the kind the map suggests. */
  class?: string;
}

export interface TiledMapOptions {
  spaces?: DrawnSpace[];
  /** Whether people enter the campus here. One map of a campus must. */
  entry?: boolean;
  /** Left out, the map has nothing nobody can walk through, and is refused. */
  walls?: boolean;
}

const TILE = 32;

/**
 * A 20 × 20 Tiled map: a wall along its top row, a spawn at tile 1,1 when it
 * is the entry map, and each space a one-tile square on a row of its own.
 */
export function tiledMap({
  spaces = [],
  entry = true,
  walls = true,
}: TiledMapOptions = {}): Record<string, unknown> {
  let nextId = 1;
  const layers: Record<string, unknown>[] = [];
  if (walls) {
    layers.push({
      type: 'objectgroup',
      name: 'collisions',
      objects: [{ id: nextId++, x: 0, y: 0, width: 20 * TILE, height: TILE }],
    });
  }
  if (entry) {
    layers.push({
      type: 'objectgroup',
      name: 'spawn',
      objects: [{ id: nextId++, x: 1.5 * TILE, y: 1.5 * TILE, point: true }],
    });
  }
  if (spaces.length > 0) {
    layers.push({
      type: 'objectgroup',
      name: 'spaces',
      objects: spaces.map((space, index) => ({
        id: nextId++,
        name: space.key,
        ...(space.class === undefined ? {} : { type: space.class }),
        x: (1 + (index % 9) * 2) * TILE,
        y: (3 + Math.floor(index / 9) * 2) * TILE,
        width: TILE,
        height: TILE,
        properties:
          space.name === undefined
            ? []
            : [{ name: 'name', type: 'string', value: space.name }],
      })),
    });
  }
  return {
    width: 20,
    height: 20,
    tilewidth: TILE,
    tileheight: TILE,
    infinite: false,
    tilesets: [],
    layers,
  };
}

export interface FakeSanity {
  fetch: typeof fetch;
  /** Every address asked for, in order. */
  asked: string[];
}

/**
 * Answers for Sanity: the manifest query with one manifest per map given,
 * and each map's address with its JSON. `versions` names a map's version;
 * left out, it is `<id>-v1`.
 */
export function fakeSanity(
  maps: Record<string, Record<string, unknown>>,
  versions: Record<string, string> = {},
): FakeSanity {
  const asked: string[] = [];
  const urlOf = (id: string) =>
    `https://cdn.sanity.io/files/e2e/e2e/${id}.json`;
  const manifests = Object.entries(maps).map(([mapId, map]) => ({
    mapId,
    version: versions[mapId] ?? `${mapId}-v1`,
    widthTiles: map.width,
    heightTiles: map.height,
    isEntry: (map.layers as { name?: string }[]).some(
      (layer) => layer.name === 'spawn',
    ),
    mapUrl: urlOf(mapId),
    tilesets: [],
  }));

  const answer = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('/data/query/')) {
      return new Response(JSON.stringify({ result: manifests }));
    }
    const id = Object.keys(maps).find((key) => url === urlOf(key));
    return id
      ? new Response(JSON.stringify(maps[id]))
      : new Response('', { status: 404 });
  }) as typeof fetch;

  return { fetch: answer, asked };
}
