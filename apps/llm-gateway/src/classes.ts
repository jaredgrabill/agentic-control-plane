/**
 * The versioned model-class registry (acp-model-classes/v1): which model
 * classes exist and which concrete provider/model bindings serve them, in
 * failover order. Manifests declare CLASSES, never model ids; rebinding a
 * class to a cheaper model is a config change + restart, never a code
 * change (cost-management.md lever 2). The loader is GateConfig-strict:
 * unknown keys are REJECTED, not ignored — a typo must never silently
 * hand a class default bindings.
 */

import { readFileSync } from 'node:fs';

export const CONFIG_KIND = 'acp-model-classes/v1';

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface ModelBinding {
  provider: string;
  model: string;
  /** Attempts against THIS binding before failing over. Default 2. */
  max_attempts: number;
  /** Per-attempt timeout. Default 30000. */
  timeout_ms: number;
}

export interface ModelClassEntry {
  bindings: ModelBinding[];
}

export type ProviderSpec =
  | { type: 'dev' }
  | { type: 'anthropic'; api_key_env: string; base_url: string; rpm?: number | undefined };

export interface ModelClassConfig {
  /** Echoed in every span and audit event — the Cost Meter's join key. */
  version: string;
  providers: Map<string, ProviderSpec>;
  classes: Map<string, ModelClassEntry>;
}

const TOP_KEYS = new Set(['kind', 'version', 'providers', 'classes']);
const DEV_PROVIDER_KEYS = new Set(['type']);
const ANTHROPIC_PROVIDER_KEYS = new Set(['type', 'api_key_env', 'base_url', 'rpm']);
const CLASS_KEYS = new Set(['bindings']);
// `batch` is reserved for batch routing (deferred): accepted, not interpreted.
const BINDING_KEYS = new Set(['provider', 'model', 'max_attempts', 'timeout_ms', 'batch']);

export function loadModelClasses(path: string): ModelClassConfig {
  return parseModelClasses(readFileSync(path, 'utf8'), path);
}

export function parseModelClasses(text: string, source = 'model-classes config'): ModelClassConfig {
  const invalid: (detail: string) => never = (detail) => {
    throw new Error(`invalid model classes config ${source}: ${detail}`);
  };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    invalid(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(raw)) invalid('expected a JSON object');
  const doc = raw;
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.has(key)) invalid(`unknown key "${key}"`);
  }
  if (doc.kind !== CONFIG_KIND) {
    invalid(`kind must be ${JSON.stringify(CONFIG_KIND)}, got ${JSON.stringify(doc.kind)}`);
  }
  if (typeof doc.version !== 'string' || doc.version === '') {
    invalid('version must be a non-empty string');
  }

  if (!isRecord(doc.providers) || Object.keys(doc.providers).length === 0) {
    invalid('providers must map at least one provider name to a spec');
  }
  const providers = new Map<string, ProviderSpec>();
  for (const [name, spec] of Object.entries(doc.providers)) {
    providers.set(name, parseProvider(name, spec, invalid));
  }

  if (!isRecord(doc.classes) || Object.keys(doc.classes).length === 0) {
    invalid('classes must map at least one model class to its bindings');
  }
  const classes = new Map<string, ModelClassEntry>();
  for (const [name, entry] of Object.entries(doc.classes)) {
    classes.set(name, parseClass(name, entry, providers, invalid));
  }

  return { version: doc.version, providers, classes };
}

function parseProvider(
  name: string,
  spec: unknown,
  invalid: (detail: string) => never,
): ProviderSpec {
  if (!isRecord(spec)) invalid(`provider ${name} must be an object`);
  const record = spec;
  if (record.type === 'dev') {
    for (const key of Object.keys(record)) {
      if (!DEV_PROVIDER_KEYS.has(key)) invalid(`provider ${name}: unknown key "${key}"`);
    }
    return { type: 'dev' };
  }
  if (record.type === 'anthropic') {
    for (const key of Object.keys(record)) {
      if (!ANTHROPIC_PROVIDER_KEYS.has(key)) invalid(`provider ${name}: unknown key "${key}"`);
    }
    if (typeof record.api_key_env !== 'string' || record.api_key_env === '') {
      invalid(`provider ${name}: api_key_env is required`);
    }
    let base_url = DEFAULT_ANTHROPIC_BASE_URL;
    if (record.base_url !== undefined) {
      if (typeof record.base_url !== 'string' || record.base_url === '') {
        invalid(`provider ${name}: base_url must be a non-empty string`);
      }
      base_url = record.base_url;
    }
    let rpm: number | undefined;
    if (record.rpm !== undefined) {
      if (typeof record.rpm !== 'number' || record.rpm <= 0) {
        invalid(`provider ${name}: rpm must be a positive number`);
      }
      rpm = record.rpm;
    }
    return { type: 'anthropic', api_key_env: record.api_key_env, base_url, rpm };
  }
  return invalid(`provider ${name}: unknown type ${JSON.stringify(record.type)}`);
}

function parseClass(
  name: string,
  entry: unknown,
  providers: Map<string, ProviderSpec>,
  invalid: (detail: string) => never,
): ModelClassEntry {
  if (!isRecord(entry)) invalid(`class ${name} must be an object`);
  const record = entry;
  for (const key of Object.keys(record)) {
    if (!CLASS_KEYS.has(key)) invalid(`class ${name}: unknown key "${key}"`);
  }
  if (!Array.isArray(record.bindings) || record.bindings.length === 0) {
    invalid(`class ${name}: bindings must be a non-empty array`);
  }
  const bindings = (record.bindings as unknown[]).map((binding, index) =>
    parseBinding(name, index, binding, providers, invalid),
  );
  return { bindings };
}

function parseBinding(
  className: string,
  index: number,
  binding: unknown,
  providers: Map<string, ProviderSpec>,
  invalid: (detail: string) => never,
): ModelBinding {
  const at = `class ${className}: bindings[${index}]`;
  if (!isRecord(binding)) invalid(`${at} must be an object`);
  const record = binding;
  for (const key of Object.keys(record)) {
    if (!BINDING_KEYS.has(key)) invalid(`${at}: unknown key "${key}"`);
  }
  if (typeof record.provider !== 'string' || record.provider === '') {
    invalid(`${at}: provider is required`);
  }
  if (!providers.has(record.provider)) {
    invalid(`${at}: unknown provider ${JSON.stringify(record.provider)}`);
  }
  if (typeof record.model !== 'string' || record.model === '') {
    invalid(`${at}: model is required`);
  }
  let max_attempts = DEFAULT_MAX_ATTEMPTS;
  if (record.max_attempts !== undefined) {
    if (!Number.isInteger(record.max_attempts) || (record.max_attempts as number) < 1) {
      invalid(`${at}: max_attempts must be a positive integer`);
    }
    max_attempts = record.max_attempts as number;
  }
  let timeout_ms = DEFAULT_TIMEOUT_MS;
  if (record.timeout_ms !== undefined) {
    if (typeof record.timeout_ms !== 'number' || record.timeout_ms <= 0) {
      invalid(`${at}: timeout_ms must be positive`);
    }
    timeout_ms = record.timeout_ms;
  }
  return { provider: record.provider, model: record.model, max_attempts, timeout_ms };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
