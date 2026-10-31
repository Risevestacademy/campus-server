import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { before } from '@nestjs/swagger/plugin';
import ts from 'typescript';
import type { Plugin } from 'vitest/config';

const fromApp = (path: string) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));

function createProgram(): ts.Program {
  const configPath = fromApp('tsconfig.build.json');
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options, fileNames } = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    fromApp(''),
  );
  return ts.createProgram(fileNames, {
    ...options,
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

  return {
    name: 'nest-swagger',
    enforce: 'pre',
    transform(_code, id) {
      if (!id.endsWith('.dto.ts')) {
        return;
      }
      program ??= createProgram();
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
