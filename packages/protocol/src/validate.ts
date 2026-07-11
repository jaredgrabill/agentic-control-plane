import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';

// ajv-formats ships CJS; at runtime the ESM default import IS the plugin
// function, but its types describe the module namespace. Narrow accordingly.
const addFormats = addFormatsImport as unknown as typeof addFormatsImport.default;
import {
  agentCardSchema,
  agentManifestSchema,
  auditEventSchema,
  taskContractSchema,
} from './generated/schemas.js';
import type { AgentCard } from './generated/agent-card.js';
import type { AgentManifest } from './generated/agent-manifest.js';
import type { AuditEvent } from './generated/audit-event.js';
import type {
  StepRequest,
  StepResult,
  TaskMessage,
  TaskRequest,
  TaskResult,
} from './generated/task-contract.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(agentManifestSchema);
ajv.addSchema(agentCardSchema);
ajv.addSchema(taskContractSchema);
ajv.addSchema(auditEventSchema);

export class ProtocolValidationError extends Error {
  constructor(
    public readonly schema: string,
    public readonly errors: string[],
  ) {
    super(
      `document does not conform to ${schema}: ${errors.join('; ')}. ` +
        'Fix the producing side — consumers never repair protocol messages.',
    );
    this.name = 'ProtocolValidationError';
  }
}

// T is bound explicitly at each call site to pair a schema ref with its
// generated type — the pairing is the point, so the "unnecessary type
// parameter" heuristic doesn't apply here.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function makeParser<T>(ref: string): {
  validate: (doc: unknown) => boolean;
  parse: (doc: unknown) => T;
  errors: (doc: unknown) => string[];
} {
  const fn = ajv.getSchema(ref) as ValidateFunction<T> | undefined;
  if (!fn) throw new Error(`schema not registered: ${ref}`);
  const errors = (doc: unknown): string[] => {
    if (fn(doc)) return [];
    return (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  };
  return {
    validate: (doc: unknown): boolean => fn(doc),
    errors,
    parse: (doc: unknown): T => {
      const errs = errors(doc);
      if (errs.length > 0) throw new ProtocolValidationError(ref, errs);
      return doc as T;
    },
  };
}

const BASE = 'https://acp.dev/schemas/v1';

export const agentManifest = makeParser<AgentManifest>(`${BASE}/agent-manifest.schema.json`);
export const agentCard = makeParser<AgentCard>(`${BASE}/agent-card.schema.json`);
export const auditEvent = makeParser<AuditEvent>(`${BASE}/audit-event.schema.json`);
export const taskMessage = makeParser<TaskMessage>(`${BASE}/task-contract.schema.json`);
export const taskRequest = makeParser<TaskRequest>(
  `${BASE}/task-contract.schema.json#/$defs/task_request`,
);
export const taskResult = makeParser<TaskResult>(
  `${BASE}/task-contract.schema.json#/$defs/task_result`,
);
export const stepRequest = makeParser<StepRequest>(
  `${BASE}/task-contract.schema.json#/$defs/step_request`,
);
export const stepResult = makeParser<StepResult>(
  `${BASE}/task-contract.schema.json#/$defs/step_result`,
);
