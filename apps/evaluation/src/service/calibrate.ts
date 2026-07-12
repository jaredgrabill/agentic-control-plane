import { GatewayClient } from '@acp/llm-client';
import {
  buildJudgeRequest,
  computeAgreement,
  loadCalibrationCases,
  loadRubric,
  parseVerdict,
  type CalibrationCase,
  type CalibrationRecord,
} from '@acp/judge';

export interface CalibrateParams {
  rubricId: string;
  modelClass: string;
  minAgreement: number;
  gatewayUrl: string;
  token: string;
  /** Explicit cases, or undefined to load the rubric's committed golden set. */
  cases?: CalibrationCase[];
  /** Load the dev (scripted) case set instead of the golden set. */
  dev?: boolean;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export interface CalibrateResult {
  record: CalibrationRecord;
  /** True when agreement met the floor. */
  passed: boolean;
  perCase: { name: string; label: boolean; score: number; outcome: string }[];
}

/**
 * Measures a judge's agreement against a labelled case set by scoring each case
 * through the gateway DIRECTLY (bypassing the calibration gate — this is the
 * measurement that PRODUCES a calibration record, so it cannot require one).
 * An unparseable verdict counts as score 0 (a disagreement, not a crash).
 */
export async function calibrate(params: CalibrateParams): Promise<CalibrateResult> {
  const rubric = loadRubric(params.rubricId);
  const cases =
    params.cases ??
    loadCalibrationCases(params.rubricId, params.dev === true ? { dev: true } : undefined);
  const gateway = new GatewayClient({
    url: params.gatewayUrl,
    ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
  });

  const perCase: CalibrateResult['perCase'] = [];
  for (const c of cases) {
    const request = buildJudgeRequest(
      rubric,
      {
        input: c.input,
        output: c.output,
        ...(c.citations !== undefined ? { citations: c.citations } : {}),
      },
      params.modelClass,
    );
    let score = 0;
    let outcome = 'scored';
    try {
      const response = await gateway.complete(request, { token: params.token });
      const parse = parseVerdict(response.text);
      if (parse.ok) score = parse.verdict.score;
      else outcome = 'unparseable_verdict';
    } catch (err) {
      outcome = `judge_error: ${err instanceof Error ? err.message : String(err)}`;
    }
    perCase.push({ name: c.name, label: c.label, score, outcome });
  }

  const agreement = computeAgreement(perCase.map((p) => ({ label: p.label, score: p.score })));
  const record: CalibrationRecord = {
    schema: 'acp-judge-calibration/v1',
    rubric: rubric.id,
    rubric_digest: rubric.digest,
    model_class: params.modelClass,
    agreement: Number(agreement.toFixed(4)),
    min_agreement: params.minAgreement,
    n: cases.length,
    generated_at: (params.now?.() ?? new Date()).toISOString(),
  };
  return { record, passed: agreement >= params.minAgreement, perCase };
}
