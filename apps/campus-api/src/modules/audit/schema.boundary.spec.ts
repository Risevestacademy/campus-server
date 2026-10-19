import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** Every module path a file imports from, relative ones only. */
const importsOf = (code: string) =>
  [...code.matchAll(/from '(\.\.?\/[^']+)'/g)].map((match) => match[1]);

/**
 * Imports from another feature module: one level up and into a sibling
 * folder. Shared code (`../../shared/...`) is not a module boundary, so it may
 * move without this test caring.
 */
const fromSiblingModules = (code: string) =>
  importsOf(code).filter((path) => /^\.\.\/[^./]/.test(path));

/**
 * The audit module depends on no feature module but for the two tables its
 * foreign keys point at. Every other module writes entries through it, so a
 * wider dependency here would be a cycle waiting to happen.
 */
describe("the audit schema's dependencies", () => {
  it('imports, from other modules, only the users and spaces tables', () => {
    expect(fromSiblingModules(source('./schema.ts')).sort()).toEqual([
      '../maps/schema.js',
      '../users/schema.js',
    ]);
    expect(source('./schema.ts')).toMatch(
      /import \{ spaces \} from '\.\.\/maps\/schema\.js'/,
    );
    expect(source('./schema.ts')).toMatch(
      /import \{ users \} from '\.\.\/users\/schema\.js'/,
    );
  });

  /** And the maps schema does not reach back: no cycle through the tables. */
  it('is not imported by the maps schema', () => {
    expect(importsOf(source('../maps/schema.ts'))).not.toContain(
      '../audit/schema.js',
    );
  });
});
