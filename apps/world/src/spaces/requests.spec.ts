import { describe, expect, it } from 'vitest';

import { tileIndex } from '../movement/grid.js';
import { spaceIndexFrom } from '../movement/spaces.js';
import { ASK_AGAIN_AFTER_MS, EntryRequests, besideSpace } from './requests.js';

const ada = { userId: 'ada', cohortId: 'cohort-1' };

describe('EntryRequests', () => {
  it('holds one open request per person', () => {
    const requests = new EntryRequests();

    expect(requests.ask(ada, 'library', 0)).toBe('asked');
    expect(requests.ask(ada, 'lab', 0)).toBe('already_asking');
    expect(requests.openFor(ada)).toEqual({ ...ada, spaceKey: 'library' });
  });

  it('keeps one cohort’s requests apart from another’s', () => {
    const requests = new EntryRequests();
    requests.ask(ada, 'library', 0);

    expect(requests.ask({ ...ada, cohortId: 'cohort-2' }, 'library', 0)).toBe(
      'asked',
    );
    expect(requests.all('cohort-1', 'library')).toEqual([
      { ...ada, spaceKey: 'library' },
    ]);
  });

  it('turns a yes into a pass for that space', () => {
    const requests = new EntryRequests();
    requests.ask(ada, 'library', 0);

    expect(requests.admit(ada)).toEqual({ ...ada, spaceKey: 'library' });
    expect(requests.openFor(ada)).toBeUndefined();
    expect(requests.passFor(ada)).toBe('library');

    requests.dropPass(ada);
    expect(requests.passFor(ada)).toBeUndefined();
  });

  it('makes them wait after a no before asking that space again', () => {
    const requests = new EntryRequests();
    requests.ask(ada, 'library', 0);
    requests.decline(ada, 1_000);

    expect(requests.ask(ada, 'library', 1_000 + ASK_AGAIN_AFTER_MS - 1)).toBe(
      'too_soon',
    );
    expect(requests.ask(ada, 'lab', 1_000)).toBe('asked');
    requests.close(ada);
    expect(requests.ask(ada, 'library', 1_000 + ASK_AGAIN_AFTER_MS)).toBe(
      'asked',
    );
  });

  it('lets them ask again at once after a withdrawal', () => {
    const requests = new EntryRequests();
    requests.ask(ada, 'library', 0);
    requests.close(ada);

    expect(requests.ask(ada, 'library', 0)).toBe('asked');
  });

  it('answers nothing for a request that is not open', () => {
    const requests = new EntryRequests();

    expect(requests.admit(ada)).toBeUndefined();
    expect(requests.decline(ada, 0)).toBeUndefined();
    expect(requests.passFor(ada)).toBeUndefined();
  });
});

describe('besideSpace', () => {
  // A 4 × 3 map, the library in its right half (x 2 to 3), a wall at (1, 2).
  const walls = new Uint8Array(4 * 3);
  walls[tileIndex({ width: 4 }, { x: 1, y: 2 })] = 1;
  const grid = { width: 4, height: 3, spawn: { x: 0, y: 0 }, walls };
  const spaces = spaceIndexFrom({
    widthTiles: 4,
    heightTiles: 3,
    collisions: [],
    spawn: { x: 0, y: 0 },
    spaces: [
      {
        key: 'library',
        name: 'Library',
        kind: null,
        bounds: { shape: 'rect', x: 2, y: 0, width: 2, height: 2 },
        properties: {},
      },
    ],
    portals: [],
    desks: [],
  });

  it('is true one step from the space’s floor', () => {
    expect(besideSpace(grid, spaces, { x: 1, y: 0 }, 'library')).toBe(true);
    expect(besideSpace(grid, spaces, { x: 2, y: 2 }, 'library')).toBe(true);
  });

  it('is false further away, or only diagonally', () => {
    expect(besideSpace(grid, spaces, { x: 0, y: 0 }, 'library')).toBe(false);
    expect(besideSpace(grid, spaces, { x: 1, y: 2 }, 'library')).toBe(false);
  });

  it('is false for another space', () => {
    expect(besideSpace(grid, spaces, { x: 1, y: 0 }, 'lab')).toBe(false);
  });
});
