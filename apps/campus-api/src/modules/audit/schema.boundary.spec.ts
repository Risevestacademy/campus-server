import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** Every module path a file imports from, relative ones only. */
const importsOf = (code: string) =>
  [...code.matchAll(/from '(\.\.?\/[^']+)'/g)].map((match) => match[1]);

/**
 * The audit module depends on no feature module but for the two tables its
 * foreign keys point at. Every other module writes entries through it, so a
 * wider dependency here would be a cycle waiting to happen.
 */
describe("the audit schema's dependencies", () => {
  it('imports, from other modules, only the users and spaces tables', () => {
    const fromOtherModules = importsOf(source('./schema.ts')).filter((path) =>
      path.startsWith('../'),
    );

    expect(fromOtherModules.sort()).toEqual([
      '../../shared/http/correlation-id.js',
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
