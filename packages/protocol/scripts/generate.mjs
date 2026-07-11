/**
 * Generates both language bindings from the JSON Schema sources in ./schemas:
 *
 *   TypeScript  → src/generated/*.ts            (json-schema-to-typescript)
 *   Python      → python/acp-protocol/src/acp_protocol/generated/*.py
 *                                               (datamodel-code-generator via uv)
 *
 * Also embeds the schema documents and subject vocabulary as TypeScript
 * consts (no runtime fs reads from dist) and copies them into the Python
 * package data. Output is deterministic; CI fails if a schema change lands
 * without regenerated bindings.
 */
import { compileFromFile } from 'json-schema-to-typescript';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '..', '..');
const schemasDir = join(pkgDir, 'schemas');
const tsOutDir = join(pkgDir, 'src', 'generated');
const pyPkgDir = join(repoRoot, 'python', 'acp-protocol', 'src', 'acp_protocol');
const pyOutDir = join(pyPkgDir, 'generated');

const BANNER =
  '/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */\n\n/* eslint-disable */';

const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));
const moduleName = (f) => f.replace('.schema.json', '');
const pyModuleName = (f) => moduleName(f).replaceAll('-', '_');

rmSync(tsOutDir, { recursive: true, force: true });
mkdirSync(tsOutDir, { recursive: true });

// --- TypeScript types ---
for (const file of schemaFiles) {
  const ts = await compileFromFile(join(schemasDir, file), {
    cwd: schemasDir,
    bannerComment: BANNER,
    additionalProperties: false,
    style: { singleQuote: true, printWidth: 100 },
  });
  writeFileSync(join(tsOutDir, `${moduleName(file)}.ts`), ts);
}

// --- Embedded schema documents + subject vocabulary (TS consts) ---
const schemaConsts = schemaFiles
  .map((file) => {
    const name = pyModuleName(file).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const body = JSON.stringify(JSON.parse(readFileSync(join(schemasDir, file), 'utf8')), null, 2);
    return `export const ${name}Schema = ${body} as const;`;
  })
  .join('\n\n');
writeFileSync(join(tsOutDir, 'schemas.ts'), `${BANNER}\n${schemaConsts}\n`);

const subjects = JSON.stringify(
  JSON.parse(readFileSync(join(schemasDir, 'subjects.json'), 'utf8')),
  null,
  2,
);
writeFileSync(
  join(tsOutDir, 'subjects-data.ts'),
  `${BANNER}\nexport const subjectsData = ${subjects} as const;\n`,
);

// Shared $defs (e.g. uuid) compile to identically-named types in more than
// one module; a bare `export *` barrel would be ambiguous. First module to
// export a name wins — the aliases are structurally identical.
const seen = new Set();
const indexLines = [];
for (const file of schemaFiles) {
  const src = readFileSync(join(tsOutDir, `${moduleName(file)}.ts`), 'utf8');
  const names = [...src.matchAll(/^export (?:interface|type) (\w+)/gm)]
    .map((m) => m[1])
    .filter((n) => !seen.has(n));
  names.forEach((n) => seen.add(n));
  indexLines.push(`export type { ${names.join(', ')} } from './${moduleName(file)}.js';`);
}
indexLines.push(`export * from './schemas.js';`, `export * from './subjects-data.js';`);
writeFileSync(join(tsOutDir, 'index.ts'), `${BANNER}\n${indexLines.join('\n')}\n`);

// --- Python (pydantic v2) models ---
rmSync(pyOutDir, { recursive: true, force: true });
mkdirSync(pyOutDir, { recursive: true });
for (const file of schemaFiles) {
  execFileSync(
    'uv',
    [
      'run',
      '--directory',
      join(repoRoot, 'python'),
      'datamodel-codegen',
      '--input',
      join(schemasDir, file),
      '--input-file-type',
      'jsonschema',
      '--output',
      join(pyOutDir, `${pyModuleName(file)}.py`),
      '--output-model-type',
      'pydantic_v2.BaseModel',
      '--target-python-version',
      '3.12',
      '--use-schema-description',
      '--use-double-quotes',
      '--use-union-operator',
      '--use-standard-collections',
      '--field-constraints',
      '--disable-timestamp',
      '--use-title-as-name',
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
}
const pyInit = [
  '"""Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`."""',
  ...schemaFiles.map((f) => `from . import ${pyModuleName(f)} as ${pyModuleName(f)}`),
  '',
].join('\n');
writeFileSync(join(pyOutDir, '__init__.py'), pyInit);

// --- Schema documents as Python package data (runtime validation + subjects) ---
const pySchemasDir = join(pyPkgDir, 'schemas');
rmSync(pySchemasDir, { recursive: true, force: true });
cpSync(schemasDir, pySchemasDir, { recursive: true });

console.log(`generated: ${schemaFiles.length} schemas → TS (${tsOutDir}) + Python (${pyOutDir})`);
