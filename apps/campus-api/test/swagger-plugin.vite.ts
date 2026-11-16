import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { before } from '@nestjs/swagger/plugin';
import ts from 'typescript';
import type { Plugin } from 'vitest/config';

const fromApp = (path: string) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));

function createProgram(paths: Record<string, string[]>): ts.Program {
  const configPath = fromApp('tsconfig.build.json');
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options, fileNames } = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    fromApp(''),
  );
  return ts.createProgram(fileNames, {
    ...options,
    // A workspace package with no build has no types, and the plugin would
    // document anything typed from it as a bare object.
    paths,
    rootDir: undefined,
    declaration: false,
    incremental: false,
    sourceMap: false,
    inlineSourceMap: true,
    inlineSources: true,
  });
}

/**
 * Vitest does not compile through `nest build`, so without this the DTOs in a
 * test carry none of what the OpenAPI document is built from. Runs the same
 * transformer, with the same options, as the real build.
 */
export function swaggerPlugin(): Plugin {
  const nestCli = JSON.parse(readFileSync(fromApp('nest-cli.json'), 'utf8'));
  const { options } = nestCli.compilerOptions.plugins.find(
    (plugin: { name: string }) => plugin.name === '@nestjs/swagger',
  );
  let program: ts.Program | undefined;
  const paths: Record<string, string[]> = {};

  return {
    name: 'nest-swagger',
    enforce: 'pre',
    configResolved(config) {
      for (const { find, replacement } of config.resolve.alias) {
        if (typeof find === 'string') {
          paths[find] = [replacement];
        }
      }
    },
    transform(_code, id) {
      if (!id.endsWith('.dto.ts')) {
        return;
      }
      program ??= createProgram(paths);
      const sourceFile = program.getSourceFile(id);
      if (!sourceFile) {
        return;
      }
      let code: string | undefined;
      program.emit(
        sourceFile,
        (fileName, text) => {
          if (fileName.endsWith('.js')) {
            code = text;
          }
        },
        undefined,
        false,
        { before: [before(options, program)] },
      );
      return code;
    },
  };
}
