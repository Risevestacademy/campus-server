import { fakeSanity, tiledMap } from '../../../test/support/published-maps.js';
import type { Env } from '../../infra/config/env.js';
import {
  PublishedMapsRejectedException,
  PublishedMapsUnavailableException,
} from './maps.exceptions.js';
import { PublishedMapsReader } from './published-maps.js';

const CONFIG = {
  SANITY_PROJECT_ID: 'abc123',
  SANITY_DATASET: 'staging',
} as Env;

const reader = (fetcher: typeof fetch, config: Partial<Env> = CONFIG) =>
  new PublishedMapsReader(config as Env, fetcher);

/** The lines an admin is shown when the maps cannot be adopted. */
async function problemsOf(read: Promise<unknown>): Promise<string[]> {
  const error = await read.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(PublishedMapsRejectedException);
  return (error as PublishedMapsRejectedException).details
    ?.problems as string[];
}

describe('PublishedMapsReader', () => {
  it('reads each map: which it is, at what version, and the spaces drawn on it', async () => {
    const sanity = fakeSanity(
      {
        campus: tiledMap({
          spaces: [
            { key: 'library', name: 'The Library', class: 'open' },
            { key: 'room_1', class: 'meeting_room' },
            { key: 'nook' },
          ],
        }),
        annex: tiledMap({ entry: false }),
      },
      { campus: 'd686dbad' },
    );

    await expect(reader(sanity.fetch).read()).resolves.toEqual([
      // In the order Sanity gives them.
      {
        key: 'campus',
        version: 'd686dbad',
        isEntry: true,
        spaces: [
          { key: 'library', name: 'The Library', tiledClass: 'open' },
          // No `name` property: it is called by its key.
          { key: 'room_1', name: 'room_1', tiledClass: 'meeting_room' },
          // No class at all: the map suggests nothing.
          { key: 'nook', name: 'nook', tiledClass: null },
        ],
      },
      { key: 'annex', version: 'annex-v1', isEntry: false, spaces: [] },
    ]);
  });

  it('asks the project and dataset it was configured with, past the CDN', async () => {
    const sanity = fakeSanity({ campus: tiledMap() });

    await reader(sanity.fetch).read();

    // Not apicdn: a sync run right after a publish must see that publish.
    expect(sanity.asked[0]).toMatch(
      /^https:\/\/abc123\.api\.sanity\.io\/.*\/data\/query\/staging\?/,
    );
  });

  describe('when the maps cannot be read at all', () => {
    it('says this deployment is not set up, without asking anybody', async () => {
      const fetcher = vi.fn();

      await expect(
        reader(fetcher, { SANITY_DATASET: 'staging' }).read(),
      ).rejects.toMatchObject({
        constructor: PublishedMapsUnavailableException,
        details: { reason: 'not_configured' },
      });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
      [
        'Sanity cannot be reached',
        (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
      ],
      [
        'Sanity refuses',
        (async () => new Response('', { status: 503 })) as typeof fetch,
      ],
    ])('says so when %s', async (_, fetcher) => {
      await expect(reader(fetcher).read()).rejects.toMatchObject({
        constructor: PublishedMapsUnavailableException,
        details: { reason: 'unreachable' },
      });
    });

    /** The manifest arrived; it is a map file behind it that did not. */
    it('says so when a map file cannot be fetched', async () => {
      const sanity = fakeSanity({ campus: tiledMap() });
      const fetcher = (async (input: string | URL | Request) =>
        String(input).includes('/data/query/')
          ? sanity.fetch(input)
          : new Response('', { status: 404 })) as typeof fetch;

      await expect(reader(fetcher).read()).rejects.toBeInstanceOf(
        PublishedMapsUnavailableException,
      );
    });
  });

  /**
   * Read, and not fit to adopt. Each of these is for whoever publishes maps
   * to put right, so each has to say what is wrong.
   */
  describe('when the maps cannot be adopted', () => {
    it('refuses when nothing is published', async () => {
      await expect(
        problemsOf(reader(fakeSanity({}).fetch).read()),
      ).resolves.toEqual(['No maps have been published.']);
    });

    it('refuses a map the reader cannot make sense of, naming each fault', async () => {
      const broken = tiledMap({ spaces: [{ key: 'library' }] });
      const layers = broken.layers as { name: string; objects: object[] }[];
      // A space with no name, and one that is an ellipse.
      layers
        .find((layer) => layer.name === 'spaces')
        ?.objects.push(
          { id: 90, x: 320, y: 320, width: 32, height: 32 },
          {
            id: 91,
            name: 'pond',
            x: 384,
            y: 320,
            width: 32,
            height: 32,
            ellipse: true,
          },
        );

      const problems = await problemsOf(
        reader(fakeSanity({ campus: broken }).fetch).read(),
      );

      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/object 90 has no name/);
      expect(problems[1]).toMatch(/object 91 is an ellipse/);
    });

    /**
     * Every broken map is named, not only the first to fail, and in the same
     * order whichever order Sanity lists them in.
     */
    it('names what is wrong with every map, in the order of their keys', async () => {
      const withUnnamedSpace = (entry: boolean) => {
        const map = tiledMap({ entry, spaces: [{ key: 'library' }] });
        (map.layers as { name: string; objects: object[] }[])
          .find((layer) => layer.name === 'spaces')
          ?.objects.push({ id: 90, x: 320, y: 320, width: 32, height: 32 });
        return map;
      };
      const tooLong = tiledMap({
        entry: false,
        spaces: [{ key: 'k'.repeat(65) }],
      });

      const answers = await Promise.all(
        [
          {
            zeta: withUnnamedSpace(true),
            alpha: withUnnamedSpace(false),
            mid: tooLong,
          },
          {
            mid: tooLong,
            alpha: withUnnamedSpace(false),
            zeta: withUnnamedSpace(true),
          },
        ].map((maps) => problemsOf(reader(fakeSanity(maps).fetch).read())),
      );

      expect(answers[0]).toEqual([
        expect.stringMatching(/^Map "alpha": .*object 90 has no name/),
        expect.stringMatching(/^Space "k+" on "mid" has a name longer than 64/),
        expect.stringMatching(/^Map "zeta": .*object 90 has no name/),
      ]);
      expect(answers[1]).toEqual(answers[0]);
    });

    /**
     * One map cannot be read, and another has a portal to a map that does
     * not exist. Both are reported. What only the unreadable map could settle
     * is not: a portal into it, and the want of an entry map, since the
     * unreadable one is where people would have entered.
     */
    it('checks the links between the maps it could read, even when one could not be', async () => {
      const unreadable = tiledMap({ entry: true, spaces: [{ key: 'lobby' }] });
      (unreadable.layers as { name: string; objects: object[] }[])
        .find((layer) => layer.name === 'spaces')
        ?.objects.push({ id: 90, x: 320, y: 320, width: 32, height: 32 });
      const withPortals = tiledMap({ entry: false });
      (withPortals.layers as Record<string, unknown>[]).push({
        type: 'objectgroup',
        name: 'portals',
        objects: [portal(80, 'atrium', 2, 2), portal(81, 'nowhere', 2, 2)],
      });

      const problems = await problemsOf(
        reader(
          fakeSanity({ library: withPortals, atrium: unreadable }).fetch,
        ).read(),
      );

      expect(problems).toEqual([
        expect.stringMatching(/^Map "atrium": .*object 90 has no name/),
        expect.stringMatching(
          /Portal on "library" to "nowhere" .* does not exist/,
        ),
      ]);
    });

    it.each([
      ['no map people enter on', { a: tiledMap({ entry: false }) }, /spawn/],
      [
        'two maps people enter on',
        { a: tiledMap(), b: tiledMap() },
        /Several maps have a "spawn" layer/,
      ],
    ])('refuses a campus with %s', async (_, maps, expected) => {
      const problems = await problemsOf(reader(fakeSanity(maps).fetch).read());

      expect(problems.join(' ')).toMatch(expected);
    });

    /** `_default` is the key of a map's own default space, drawn nowhere. */
    it('refuses a drawn space that takes the default space’s key', async () => {
      const problems = await problemsOf(
        reader(
          fakeSanity({ campus: tiledMap({ spaces: [{ key: '_default' }] }) })
            .fetch,
        ).read(),
      );

      expect(problems).toEqual([
        expect.stringMatching(/"_default" on "campus" uses a name kept for/),
      ]);
    });

    /**
     * A space is known by its name on its map, so two with one name would be
     * one row here. The package refuses them; this holds it to that, because
     * the sync has no answer of its own for which of the two the row is.
     */
    it('refuses two spaces on a map with the same name', async () => {
      const problems = await problemsOf(
        reader(
          fakeSanity({
            campus: tiledMap({
              spaces: [{ key: 'hall' }, { key: 'lab' }, { key: 'hall' }],
            }),
          }).fetch,
        ).read(),
      );

      expect(problems).toEqual([
        expect.stringMatching(/reuses the key "hall"/),
      ]);
    });

    it('refuses keys and names too long for their columns', async () => {
      const problems = await problemsOf(
        reader(
          fakeSanity({
            campus: tiledMap({
              spaces: [
                { key: 'k'.repeat(65) },
                { key: 'hall', name: 'n'.repeat(129) },
              ],
            }),
          }).fetch,
        ).read(),
      );

      expect(problems).toEqual([
        expect.stringMatching(/name longer than 64 characters/),
        expect.stringMatching(
          /"hall" on "campus" has a display name longer than 128/,
        ),
      ]);
    });
  });
});

/** A one-tile portal object at row 4, leading to tile (x, y) on `toMap`. */
function portal(id: number, toMap: string, toX: number, toY: number) {
  return {
    id,
    x: (id % 10) * 64,
    y: 4 * 32,
    width: 32,
    height: 32,
    properties: [
      { name: 'toMap', type: 'string', value: toMap },
      { name: 'toX', type: 'int', value: toX },
      { name: 'toY', type: 'int', value: toY },
    ],
  };
}
