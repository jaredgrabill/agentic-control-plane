import { LlmGatewayError, type GatewayClient } from '@acp/llm-client';
import { assertCalibrated, type CalibrationRecord, DEFAULT_MIN_AGREEMENT } from './calibration.js';
import { loadRubric, type Rubric } from './rubric.js';
import { buildJudgeRequest, type JudgeSample } from './template.js';
import { parseVerdict, type JudgeVerdict } from './verdict.js';

export const DEFAULT_MODEL_CLASS = 'default-tier';

/**
 * The outcome of one scoring attempt. Only `scored` carries a quality
 * observation the caller may ingest into an error budget. Every other outcome
 * is a JUDGE condition (unproven, broken, or unreadable) and MUST NOT become
 * an agent quality observation:
 *  - `uncalibrated`  — the judge refused to score (no LLM call was made);
 *  - `judge_error`   — the gateway failed (unavailable / rate-limited / etc.);
 *  - `unparseable_verdict` — a completion returned but no valid verdict parsed.
 */
export type ScoreOutcome = 'scored' | 'uncalibrated' | 'judge_error' | 'unparseable_verdict';

export interface ScoreResult {
  outcome: ScoreOutcome;
  rubric: string;
  rubric_digest: string;
  model_class: string;
  /** Present iff outcome === 'scored'. */
  score?: number;
  /** Present iff outcome === 'scored'. */
  verdict?: JudgeVerdict;
  /** The concrete model that answered (present once a completion returned). */
  model?: string;
  /** The proven agreement of the calibration that authorized this score. */
  calibration?: { agreement: number; min_agreement: number };
  /** Human-readable reason for a non-scored outcome. */
  detail?: string;
}

export interface JudgeOptions {
  gateway: GatewayClient;
  /** Fetches a fresh acp:llm bearer token (scope llm:invoke) per call (≤15min TTL). */
  tokenProvider: () => Promise<string>;
  /** The committed rubric to judge against. */
  rubric: Rubric;
  /** Committed calibration records; the gate matches on {rubric_digest, model_class}. */
  calibration: CalibrationRecord[];
  /** Model class to judge with (default 'default-tier'). */
  modelClass?: string;
  /** Agreement floor (default 0.85). */
  minAgreement?: number;
}

/**
 * The calibrated judge. One instance = one rubric + its calibration set. Used
 * in two venues behind the same code: apps/evaluation (offline gate) and the
 * orchestrator's scoreWithJudge activity (online sampled scoring).
 */
export class Judge {
  private readonly gateway: GatewayClient;
  private readonly tokenProvider: () => Promise<string>;
  readonly rubric: Rubric;
  private readonly calibration: CalibrationRecord[];
  readonly modelClass: string;
  private readonly minAgreement: number;

  constructor(opts: JudgeOptions) {
    this.gateway = opts.gateway;
    this.tokenProvider = opts.tokenProvider;
    this.rubric = opts.rubric;
    this.calibration = opts.calibration;
    this.modelClass = opts.modelClass ?? DEFAULT_MODEL_CLASS;
    this.minAgreement = opts.minAgreement ?? DEFAULT_MIN_AGREEMENT;
  }

  /**
   * Scores one sample. Calibration is checked FIRST: an uncalibrated judge
   * refuses without any LLM call. A gateway failure is `judge_error`, an
   * unreadable completion is `unparseable_verdict` — neither is a quality
   * observation.
   */
  async score(sample: JudgeSample): Promise<ScoreResult> {
    const base = {
      rubric: this.rubric.id,
      rubric_digest: this.rubric.digest,
      model_class: this.modelClass,
    };

    const check = assertCalibrated(this.calibration, {
      rubricDigest: this.rubric.digest,
      modelClass: this.modelClass,
      minAgreement: this.minAgreement,
    });
    if (!check.calibrated) {
      return { ...base, outcome: 'uncalibrated', detail: check.detail };
    }
    const calibration = {
      agreement: check.record.agreement,
      min_agreement: check.record.min_agreement,
    };

    let token: string;
    let text: string;
    let model: string;
    try {
      token = await this.tokenProvider();
      const response = await this.gateway.complete(
        buildJudgeRequest(this.rubric, sample, this.modelClass),
        { token },
      );
      text = response.text;
      model = response.model;
    } catch (err) {
      const detail =
        err instanceof LlmGatewayError
          ? `${err.errorClass}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { ...base, outcome: 'judge_error', calibration, detail };
    }

    const parse = parseVerdict(text);
    if (!parse.ok) {
      return { ...base, outcome: 'unparseable_verdict', model, calibration, detail: parse.detail };
    }
    return {
      ...base,
      outcome: 'scored',
      score: parse.verdict.score,
      verdict: parse.verdict,
      model,
      calibration,
    };
  }
}

/** Convenience: build a Judge for the default rubric loaded from disk. */
export function createJudge(opts: Omit<JudgeOptions, 'rubric'> & { rubricId?: string }): Judge {
  const rubric: Rubric = loadRubric(opts.rubricId ?? 'answer-quality@1');
  return new Judge({ ...opts, rubric });
}
