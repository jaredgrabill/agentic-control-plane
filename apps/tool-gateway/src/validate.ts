/**
 * Ajv validation of tool-call arguments against the schema the upstream
 * server itself advertises via tools/list — the gateway refuses calls the
 * upstream would reject, with actionable violations, before any credential
 * is brokered. Compiled validators are cached per schema object; a TTL
 * refresh of the upstream list yields new objects and hence recompilation.
 */

import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsImport from 'ajv-formats';

// ajv-formats ships CJS; at runtime the ESM default import IS the plugin
// function, but its types describe the module namespace. Narrow accordingly.
const addFormats = addFormatsImport as unknown as typeof addFormatsImport.default;

export type ValidationResult = { ok: true } | { ok: false; violations: string[] };

const MAX_VIOLATIONS = 3;

export class ToolInputValidators {
  private readonly ajv: Ajv;
  private readonly cache = new WeakMap<object, ValidateFunction>();

  constructor() {
    // strict:false — upstream schemas are third-party documents; Ajv must
    // validate against them, not lint them.
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
  }

  validate(schema: unknown, args: unknown): ValidationResult {
    if (typeof schema !== 'object' || schema === null) return { ok: true };
    let validator = this.cache.get(schema);
    if (validator === undefined) {
      validator = this.ajv.compile(schema);
      this.cache.set(schema, validator);
    }
    if (validator(args)) return { ok: true };
    const violations = (validator.errors ?? [])
      .slice(0, MAX_VIOLATIONS)
      .map((e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'is invalid'}`);
    return { ok: false, violations };
  }
}
