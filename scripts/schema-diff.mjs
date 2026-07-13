/**
 * Protocol schema breaking-change gate (Phase 4 item 5, WS5).
 *
 * The public wire contract is the set of JSON Schemas under
 * packages/protocol/schemas plus the NATS subject grammar (subjects.json).
 * At 1.0 that surface is frozen under SemVer (docs/standards/api-versioning.md):
 * a change that forces any consumer (TypeScript, Python, or an external A2A
 * client) to change is BREAKING and may ship only in a major bump.
 *
 * This tool compares the CURRENT schema surface against a committed baseline
 * (packages/protocol/schema-baseline.json — the frozen contract) and classifies
 * every difference as `breaking` or `additive`. A no-change PR is byte-identical
 * to the baseline and produces zero findings. Additive changes (new optional
 * field, new enum value, new schema, new subject) pass. Breaking changes fail
 * the gate unless the change is a deliberate major bump — see --allow-breaking.
 *
 * It complements, not replaces, the existing gates: `contracts` (bindings match
 * schemas) and `parity` (TS and Python agree case by case) prove the two
 * languages stay in sync; this gate proves the frozen contract does not regress.
 *
 * Usage:
 *   node scripts/schema-diff.mjs                 # repo schemas vs committed baseline
 *   node scripts/schema-diff.mjs --allow-breaking# report breaking but exit 0 (major bump)
 *   node scripts/schema-diff.mjs --write-baseline# freeze the current surface as the baseline
 *   node scripts/schema-diff.mjs --baseline a.json --current b.json  # two bundle files (tests)
 *
 * Exit codes: 0 = compatible (or breaking allowed), 1 = breaking change rejected,
 * 2 = usage/IO error (nothing was ever gated).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SCHEMAS_DIR = join(REPO_ROOT, 'packages', 'protocol', 'schemas');
const BASELINE_PATH = join(REPO_ROOT, 'packages', 'protocol', 'schema-baseline.json');

/** Read the live schema surface into a stable {schemas, subjects} bundle. */
export function readCurrentBundle(schemasDir = SCHEMAS_DIR) {
  const files = readdirSync(schemasDir)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
  const schemas = {};
  for (const file of files) {
    schemas[file] = JSON.parse(readFileSync(join(schemasDir, file), 'utf8'));
  }
  const subjects = JSON.parse(readFileSync(join(schemasDir, 'subjects.json'), 'utf8'));
  return { schemas, subjects };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

// Numeric constraints and their tightening direction. A higher `min*` or a
// lower `max*` narrows the accepted set → breaking; the reverse loosens it.
const TIGHTEN_UP = ['minLength', 'minItems', 'minimum', 'exclusiveMinimum', 'minProperties'];
const TIGHTEN_DOWN = ['maxLength', 'maxItems', 'maximum', 'exclusiveMaximum', 'maxProperties'];

function diffSchemaNode(path, base, cur, out) {
  const breaking = (msg) => out.breaking.push({ path, msg });
  const additive = (msg) => out.additive.push({ path, msg });

  if (!isObject(base) || !isObject(cur)) {
    // Leaf mismatch (e.g. a scalar keyword value replaced by an object) —
    // only report when the JSON differs, and treat a structural swap as breaking.
    if (JSON.stringify(base) !== JSON.stringify(cur)) breaking(`shape changed`);
    return;
  }

  // type: any change narrows or retypes the value → breaking; ADDING a type
  // where the baseline was untyped also narrows the accepted set → breaking.
  if ('type' in base) {
    if (JSON.stringify(base.type) !== JSON.stringify(cur.type)) {
      breaking(`type ${JSON.stringify(base.type)} → ${JSON.stringify(cur.type)}`);
    }
  } else if ('type' in cur) {
    breaking(`type constraint added: ${JSON.stringify(cur.type)}`);
  }
  // const / format: a changed OR newly-added literal/format narrows validators.
  if ('const' in base) {
    if (JSON.stringify(base.const) !== JSON.stringify(cur.const)) {
      breaking(`const ${JSON.stringify(base.const)} → ${JSON.stringify(cur.const)}`);
    }
  } else if ('const' in cur) {
    breaking(`const constraint added: ${JSON.stringify(cur.const)}`);
  }
  if ('format' in base) {
    if (base.format !== cur.format) breaking(`format ${base.format} → ${cur.format}`);
  } else if ('format' in cur) {
    breaking(`format constraint added: ${cur.format}`);
  }
  // pattern: any change OR a newly-added pattern tightens a string field → breaking.
  if ('pattern' in base) {
    if (base.pattern !== cur.pattern) breaking(`pattern changed`);
  } else if ('pattern' in cur) {
    breaking(`pattern constraint added`);
  }
  // $ref retarget is a structural change of the referenced contract.
  if ('$ref' in base && base.$ref !== cur.$ref) {
    breaking(`$ref ${base.$ref} → ${cur.$ref}`);
  }

  // additionalProperties: closing an open object rejects previously-valid docs.
  const baseAP = base.additionalProperties;
  const curAP = cur.additionalProperties;
  if (baseAP !== false && curAP === false) {
    breaking(`additionalProperties true → false`);
  } else if (isObject(baseAP) && isObject(curAP)) {
    diffSchemaNode(`${path}.additionalProperties`, baseAP, curAP, out);
  }

  // required: a newly-required field rejects producers that omit it.
  const baseReq = new Set(arr(base.required));
  const curReq = new Set(arr(cur.required));
  for (const name of curReq) {
    if (!baseReq.has(name)) breaking(`required field added: ${name}`);
  }
  for (const name of baseReq) {
    if (!curReq.has(name)) additive(`required field relaxed to optional: ${name}`);
  }

  // enum: append-only. A removed value rejects previously-valid documents and,
  // for the audit event_type enum, breaks the hash chain / historical decode.
  if (Array.isArray(base.enum)) {
    const curEnum = new Set(arr(cur.enum));
    const baseEnum = new Set(base.enum);
    for (const v of base.enum) {
      if (!curEnum.has(v)) breaking(`enum value removed: ${JSON.stringify(v)}`);
    }
    for (const v of arr(cur.enum)) {
      if (!baseEnum.has(v)) additive(`enum value added: ${JSON.stringify(v)}`);
    }
  } else if (Array.isArray(cur.enum)) {
    // A newly-added enum where the baseline was free-form restricts the set.
    breaking(`enum constraint added: ${JSON.stringify(cur.enum)}`);
  }

  // Numeric constraints: added or tightened → breaking; removed or loosened → additive.
  for (const k of TIGHTEN_UP) {
    if (k in base && k in cur && cur[k] > base[k])
      breaking(`${k} tightened ${base[k]} → ${cur[k]}`);
    else if (k in base && !(k in cur)) additive(`${k} removed`);
    else if (!(k in base) && k in cur) breaking(`${k} added: ${cur[k]}`);
  }
  for (const k of TIGHTEN_DOWN) {
    if (k in base && k in cur && cur[k] < base[k])
      breaking(`${k} tightened ${base[k]} → ${cur[k]}`);
    else if (k in base && !(k in cur)) additive(`${k} removed`);
    else if (!(k in base) && k in cur) breaking(`${k} added: ${cur[k]}`);
  }

  // oneOf/anyOf/allOf: dropping a branch removes an accepted shape → breaking.
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (!(key in base)) continue;
    const b = arr(base[key]);
    const c = arr(cur[key]);
    if (c.length < b.length) breaking(`${key} branch removed (${b.length} → ${c.length})`);
    const n = Math.min(b.length, c.length);
    for (let i = 0; i < n; i += 1) diffSchemaNode(`${path}.${key}[${i}]`, b[i], c[i], out);
  }

  // Recurse into nested schema maps: properties and $defs.
  for (const key of ['properties', '$defs']) {
    if (!isObject(base[key])) continue;
    const baseMap = base[key];
    const curMap = isObject(cur[key]) ? cur[key] : {};
    for (const name of Object.keys(baseMap)) {
      if (!(name in curMap))
        breaking(`${key === '$defs' ? 'definition' : 'property'} removed: ${name}`);
      else diffSchemaNode(`${path}.${name}`, baseMap[name], curMap[name], out);
    }
    for (const name of Object.keys(curMap)) {
      if (!(name in baseMap))
        additive(`${key === '$defs' ? 'definition' : 'property'} added: ${name}`);
    }
  }

  // items: array element contract.
  if (isObject(base.items) && isObject(cur.items)) {
    diffSchemaNode(`${path}.items`, base.items, cur.items, out);
  }
}

/** Diff two subject-grammar documents (subjects.json). */
function diffSubjects(base, cur, out) {
  const baseEnt = isObject(base?.entities) ? base.entities : {};
  const curEnt = isObject(cur?.entities) ? cur.entities : {};
  for (const name of Object.keys(baseEnt)) {
    if (!(name in curEnt)) {
      out.breaking.push({ path: `subjects.${name}`, msg: `subject entity removed` });
      continue;
    }
    const b = baseEnt[name];
    const c = curEnt[name];
    if (b.template !== c.template) {
      out.breaking.push({ path: `subjects.${name}`, msg: `template changed` });
    }
    const cVerbs = new Set(arr(c.verbs));
    for (const v of arr(b.verbs)) {
      if (!cVerbs.has(v))
        out.breaking.push({ path: `subjects.${name}`, msg: `verb removed: ${v}` });
    }
    const bVerbs = new Set(arr(b.verbs));
    for (const v of arr(c.verbs)) {
      if (!bVerbs.has(v)) out.additive.push({ path: `subjects.${name}`, msg: `verb added: ${v}` });
    }
  }
  for (const name of Object.keys(curEnt)) {
    if (!(name in baseEnt))
      out.additive.push({ path: `subjects.${name}`, msg: `subject entity added` });
  }
}

/** Compare two {schemas, subjects} bundles; returns {breaking, additive}. */
export function diffBundles(baseBundle, curBundle) {
  const out = { breaking: [], additive: [] };
  const baseSchemas = baseBundle.schemas ?? {};
  const curSchemas = curBundle.schemas ?? {};
  for (const file of Object.keys(baseSchemas)) {
    if (!(file in curSchemas)) {
      out.breaking.push({ path: file, msg: `schema removed` });
      continue;
    }
    diffSchemaNode(basename(file, '.schema.json'), baseSchemas[file], curSchemas[file], out);
  }
  for (const file of Object.keys(curSchemas)) {
    if (!(file in baseSchemas)) out.additive.push({ path: file, msg: `schema added` });
  }
  diffSubjects(baseBundle.subjects ?? {}, curBundle.subjects ?? {}, out);
  return out;
}

// --- CLI ---
function parseArgs(argv) {
  const args = { allowBreaking: false, writeBaseline: false, baseline: null, current: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-breaking') args.allowBreaking = true;
    else if (a === '--write-baseline') args.writeBaseline = true;
    else if (a === '--baseline') args.baseline = argv[(i += 1)];
    else if (a === '--current') args.current = argv[(i += 1)];
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const allowBreaking = args.allowBreaking || process.env.ACP_ALLOW_BREAKING === '1';

  if (args.writeBaseline) {
    const bundle = readCurrentBundle();
    writeFileSync(BASELINE_PATH, `${JSON.stringify(bundle, null, 2)}\n`);
    process.stdout.write(`wrote baseline: ${BASELINE_PATH}\n`);
    return 0;
  }

  let base;
  let cur;
  try {
    cur = args.current ? JSON.parse(readFileSync(args.current, 'utf8')) : readCurrentBundle();
    const baselineFile = args.baseline ?? BASELINE_PATH;
    base = JSON.parse(readFileSync(baselineFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`schema-diff: could not read inputs: ${err.message}\n`);
    return 2;
  }

  const { breaking, additive } = diffBundles(base, cur);
  for (const f of additive) process.stdout.write(`additive:  ${f.path}: ${f.msg}\n`);
  for (const f of breaking) process.stdout.write(`BREAKING:  ${f.path}: ${f.msg}\n`);

  if (breaking.length === 0) {
    process.stdout.write(
      `schema-diff: ${additive.length} additive change(s), no breaking changes.\n`,
    );
    return 0;
  }
  if (allowBreaking) {
    process.stdout.write(
      `schema-diff: ${breaking.length} breaking change(s) ALLOWED (major bump). Regenerate the baseline with --write-baseline.\n`,
    );
    return 0;
  }
  process.stderr.write(
    `schema-diff: ${breaking.length} breaking change(s) to the frozen protocol surface. ` +
      `Ship these only in a major version: add the 'breaking' PR label (or run with --allow-breaking) ` +
      `and regenerate packages/protocol/schema-baseline.json with --write-baseline.\n`,
  );
  return 1;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('schema-diff.mjs')
) {
  process.exit(main());
}
