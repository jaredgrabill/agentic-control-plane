import { Ajv, type ValidateFunction } from 'ajv';
import { EMBEDDING_DIM } from '@acp/embedding';

/** Which producer emitted a score, and which routing lane it observed. */
export type ScoreSource = 'judge' | 'probe' | 'human';
export type ScoreRoute = 'active' | 'canary' | 'shadow' | 'probe';

/**
 * The POST /v1/scores request body. `id` is a client-chosen idempotency key
 * (uuid) — a retried ingest with the same id is a no-op (ON CONFLICT DO
 * NOTHING), so a judge/probe workflow can safely retry the POST. Exactly one
 * of a judged score (source=judge) or a boolean pass (probe/human) drives the
 * observation; the store keeps both columns nullable.
 */
export interface ScoreIngest {
  id: string;
  agent_id: string;
  agent_version: string;
  capability: string;
  tenant: string;
  task_id?: string;
  step_id?: string;
  source: ScoreSource;
  route: ScoreRoute;
  /** Judged quality in [0,1]; null for a probe/human boolean observation. */
  score: number | null;
  /** Boolean outcome for a probe/human; null for a bare judged score. */
  passed: boolean | null;
  /** Observation weight (probes weigh more than a single judged sample). */
  weight: number;
  rubric?: string;
  rubric_digest?: string;
  model?: string;
  /** The judge outcome (scored / probe / …) for auditability. */
  outcome?: string;
  /** dev-hash-embed@1 embedding of the judged input, for drift; null otherwise. */
  input_embedding?: number[] | null;
}

const ajv = new Ajv({ allErrors: true });
const validate: ValidateFunction = ajv.compile({
  type: 'object',
  required: [
    'id',
    'agent_id',
    'agent_version',
    'capability',
    'tenant',
    'source',
    'route',
    'weight',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    agent_id: { type: 'string', minLength: 1 },
    agent_version: { type: 'string', minLength: 1 },
    capability: { type: 'string', minLength: 1 },
    tenant: { type: 'string', minLength: 1 },
    task_id: { type: 'string' },
    step_id: { type: 'string' },
    source: { enum: ['judge', 'probe', 'human'] },
    route: { enum: ['active', 'canary', 'shadow', 'probe'] },
    score: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    passed: { type: ['boolean', 'null'] },
    weight: { type: 'number', minimum: 0 },
    rubric: { type: 'string' },
    rubric_digest: { type: 'string' },
    model: { type: 'string' },
    outcome: { type: 'string' },
    input_embedding: {
      type: ['array', 'null'],
      items: { type: 'number' },
      minItems: EMBEDDING_DIM,
      maxItems: EMBEDDING_DIM,
    },
  },
});

export function parseScoreIngest(raw: unknown): ScoreIngest {
  if (!validate(raw)) {
    throw new Error(`invalid score ingest: ${ajv.errorsText(validate.errors)}`);
  }
  return raw as ScoreIngest;
}
