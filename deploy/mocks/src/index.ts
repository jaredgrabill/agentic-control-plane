/**
 * @acp/mock-tools — mock MCP tool servers over the acme-corp fixtures.
 * Exported factories let agent eval suites run real MCP marshalling
 * hermetically over InMemoryTransport — one fixture-serving implementation
 * for mocks and evals alike.
 */

export { fail, ok, toCallToolResult } from './shared/envelope.js';
export {
  applyTimeout,
  failureEnvelope,
  forcePartial,
  parseFailureDirective,
  type FailureDirective,
} from './shared/failure.js';
export { serveMcp, type ServeMcpOptions } from './shared/http.js';
export {
  DEFAULT_FIXTURES_DIR,
  fixturesDir,
  loadCloudFixtures,
  type CloudFixtures,
  type CloudResource,
  type CostWeek,
} from './cloud/fixtures.js';
export { costReport, searchInventory, type QueryOutcome } from './cloud/queries.js';
export { createCloudServer } from './cloud/server.js';
export { CloudStore, type TagApplyArgs, type TagRemoveArgs } from './cloud/store.js';
export { loadForgeFixtures, type CiRun, type ForgeFixtures } from './forge/fixtures.js';
export { ciRuns, repoDependencies } from './forge/queries.js';
export { createForgeServer } from './forge/server.js';
export {
  loadItsmFixtures,
  type CalendarFixture,
  type ChangeRecord,
  type ChangeStatus,
  type ChangeWindow,
  type ChangesFixture,
  type ItsmFixtures,
} from './itsm/fixtures.js';
export { ItsmStore, type ItsmOutcome } from './itsm/store.js';
export { createItsmServer } from './itsm/server.js';
export {
  argsDigest,
  DEFAULT_LEDGER_CAP,
  IdempotencyLedger,
  type LedgerLookup,
} from './shared/idempotency.js';
