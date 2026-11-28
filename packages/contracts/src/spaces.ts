/**
 * The key of a map's default space: the one for every tile inside no space
 * the designer drew, the corridors and grounds. It is drawn nowhere, so it
 * has no name in Tiled to be known by, and is given this one. campus-api
 * keeps a row for it on every map; world answers it for any tile outside
 * the drawn spaces. Defined once, so the two always name the same space.
 *
 * A drawn space may not use it: campus-api's sync refuses a map where one
 * does. Tiled names do not begin with an underscore unless somebody means
 * them to.
 */
export const DEFAULT_SPACE_KEY = '_default';
