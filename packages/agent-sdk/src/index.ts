/**
 * @acp/agent-sdk — the TypeScript twin of the Python `acp-agent-sdk`:
 * manifest-bound agents, capability handlers, governed model/retrieval
 * access, telemetry, and the golden-set eval harness.
 */

export { Agent, type AgentOptions, type Handler } from './agent.js';
export { AnswerBuilder, DEFAULT_CONFIDENCE_FLOOR } from './answer.js';
export { CapabilityContext } from './context.js';
export { CapabilityError, ErrorClass } from './errors.js';
export {
  EvalHarness,
  EvalReport,
  goldenCaseFromDict,
  loadGolden,
  type CaseResult,
  type GoldenCase,
} from './evals.js';
export { FakeModel, type FakeModelStep, type ModelClient, type ModelResponse } from './model.js';
export {
  KNOWLEDGE_AUDIENCE,
  NatsRetriever,
  TokenExchanger,
  type BusClient,
  type Retriever,
  type SearchOptions,
} from './retriever.js';
export { configureTracing, createAgentLogger, type Logger } from './telemetry.js';
