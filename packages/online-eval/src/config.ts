import { Ajv, type ValidateFunction } from 'ajv';

export const ONLINE_EVAL_SCHEMA_ID = 'acp-online-eval/v1';

/** Golden expectations a synthetic probe checks against the agent's answer. */
export interface ProbeExpect {
  /** Substrings the answer MUST contain (case-insensitive). */
  must_contain?: string[];
  /** doc_ids the answer MUST cite. */
  must_cite_docs?: string[];
  /** True when the correct behavior is abstention (answer should decline). */
  abstain?: boolean;
}

export interface ProbeCase {
  name: string;
  input: string;
  expect: ProbeExpect;
}

export interface ProbeTarget {
  agent_id: string;
  tenant: string;
  capability: string;
  cases: ProbeCase[];
}

export interface OnlineEvalConfig {
  schema: 'acp-online-eval/v1';
  /** Per-step judge sampling (orchestrator). */
  sample: {
    /** Base sample rate percent (0-100). */
    default_percent: number;
    /** Per-agent overrides (higher for new / R2 agents). */
    per_agent?: Record<string, number>;
  };
  /** Judge configuration (orchestrator + offline). */
  judge: {
    rubric: string;
    model_class: string;
    min_agreement: number;
  };
  /** Synthetic probe schedule + suite (orchestrator ProbeWorkflow). */
  probes: {
    interval_s: number;
    probe_failure_weight: number;
    targets: ProbeTarget[];
  };
  /** Error budget (eval service). */
  budget: {
    window_h: number;
    /** Minimum weighted observations before the budget can freeze (fail-open below). */
    min_samples: number;
    /** SLO when a manifest declares none. */
    slo_default: number;
  };
  /** Drift + degradation-ladder thresholds (eval service). */
  drift: {
    input_threshold: number;
    score_drop_threshold: number;
    /** Minimum current-window judge samples before drift is evaluated. */
    min_current: number;
    reference_days: number;
    cooldown_h: number;
    /** Consecutive probe failures that trip the SEVERE rung (abort deployment). */
    severe_probe_failures: number;
    /** Consecutive full-cycle probe failures that trip the FLOOR rung (auto-suspend). */
    floor_probe_cycles: number;
    /**
     * burn_ratio at/above which judge-burn escalates to the REVERSIBLE severe rung
     * (deployment-abort). It deliberately does NOT reach the floor/auto-suspend —
     * that requires golden-probe corroboration so a tenant's adversarial inputs to
     * a shared agent cannot force a platform-wide irreversible suspend.
     */
    floor_burn_ratio: number;
  };
}

const ajv = new Ajv({ allErrors: true });
const num = (min: number, max?: number): Record<string, unknown> => ({
  type: 'number',
  minimum: min,
  ...(max === undefined ? {} : { maximum: max }),
});
const validate: ValidateFunction = ajv.compile({
  type: 'object',
  required: ['schema', 'sample', 'judge', 'probes', 'budget', 'drift'],
  additionalProperties: false,
  properties: {
    schema: { const: ONLINE_EVAL_SCHEMA_ID },
    sample: {
      type: 'object',
      required: ['default_percent'],
      additionalProperties: false,
      properties: {
        default_percent: num(0, 100),
        per_agent: { type: 'object', additionalProperties: num(0, 100) },
      },
    },
    judge: {
      type: 'object',
      required: ['rubric', 'model_class', 'min_agreement'],
      additionalProperties: false,
      properties: {
        rubric: { type: 'string', minLength: 1 },
        model_class: { type: 'string', minLength: 1 },
        min_agreement: num(0, 1),
      },
    },
    probes: {
      type: 'object',
      required: ['interval_s', 'probe_failure_weight', 'targets'],
      additionalProperties: false,
      properties: {
        interval_s: num(1),
        probe_failure_weight: num(0),
        targets: {
          type: 'array',
          items: {
            type: 'object',
            required: ['agent_id', 'tenant', 'capability', 'cases'],
            additionalProperties: false,
            properties: {
              agent_id: { type: 'string', minLength: 1 },
              tenant: { type: 'string', minLength: 1 },
              capability: { type: 'string', minLength: 1 },
              cases: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['name', 'input', 'expect'],
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', minLength: 1 },
                    input: { type: 'string', minLength: 1 },
                    expect: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        must_contain: { type: 'array', items: { type: 'string' } },
                        must_cite_docs: { type: 'array', items: { type: 'string' } },
                        abstain: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    budget: {
      type: 'object',
      required: ['window_h', 'min_samples', 'slo_default'],
      additionalProperties: false,
      properties: {
        window_h: num(0),
        min_samples: num(0),
        slo_default: num(0, 1),
      },
    },
    drift: {
      type: 'object',
      required: [
        'input_threshold',
        'score_drop_threshold',
        'min_current',
        'reference_days',
        'cooldown_h',
        'severe_probe_failures',
        'floor_probe_cycles',
        'floor_burn_ratio',
      ],
      additionalProperties: false,
      properties: {
        input_threshold: num(0, 2),
        score_drop_threshold: num(0, 1),
        min_current: num(1),
        reference_days: num(0),
        cooldown_h: num(0),
        severe_probe_failures: num(1),
        floor_probe_cycles: num(1),
        floor_burn_ratio: num(0),
      },
    },
  },
});

/** Parses and strictly validates an online-eval config document. */
export function parseOnlineEvalConfig(raw: unknown): OnlineEvalConfig {
  if (!validate(raw)) {
    throw new Error(`invalid online-eval config: ${ajv.errorsText(validate.errors)}`);
  }
  return raw as OnlineEvalConfig;
}

/** Loads and validates an online-eval config from JSON text. */
export function loadOnlineEvalConfig(text: string): OnlineEvalConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `online-eval config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseOnlineEvalConfig(raw);
}
