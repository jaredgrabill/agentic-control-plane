import process from 'node:process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadOnlineEvalConfig } from '@acp/online-eval';
import {
  AuditPublisher,
  JwtVerifier,
  KillSwitchWatcher,
  connectBus,
  createLogger,
  ensureAuditStream,
  env,
  initTelemetry,
} from '@acp/service-kit';
import {
  OpenTelemetryActivityInboundInterceptor,
  makeWorkflowExporter,
} from '@temporalio/interceptors-opentelemetry';
// The Temporal interceptor package is built against the OTel 1.x SDK line;
// the workflow sink gets matching-generation exporter/resource via aliases
// while the rest of the process runs the 2.x SDK.
import { OTLPTraceExporter as LegacyOTLPTraceExporter } from 'otel-legacy-exporter';
import { Resource as LegacyResource } from 'otel-legacy-resources';
import { BatchSpanProcessor as LegacyBatchSpanProcessor } from 'otel-legacy-trace-base';
import { NativeConnection, Worker } from '@temporalio/worker';
import { defaultPriceBookPath } from '@acp/cost-meter';
import { createControlActivities } from './activities.js';
import { CONTROL_TASK_QUEUE } from './types.js';

const logger = createLogger('orchestrator');
const telemetry = initTelemetry('orchestrator');
const require = createRequire(import.meta.url);

const nc = await connectBus({
  name: 'orchestrator',
  user: env('ACP_NATS_SERVICE_USER', 'orchestrator'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'orchestrator-dev-password'),
});
await ensureAuditStream(nc);

const onlineEvalPath = env('ACP_ONLINE_EVAL', '');

const activities = createControlActivities({
  registryUrl: env('ACP_REGISTRY_URL', 'http://localhost:7102'),
  policyUrl: env('ACP_POLICY_URL', 'http://localhost:7103'),
  tokenUrl: env('ACP_TOKEN_URL', 'http://localhost:7101'),
  auditUrl: env('ACP_AUDIT_URL', 'http://localhost:7104'),
  clientId: env('ACP_ORCHESTRATOR_CLIENT_ID', 'svc-orchestrator'),
  clientSecret: env('ACP_ORCHESTRATOR_CLIENT_SECRET', 'orchestrator-dev-secret'),
  verifier: new JwtVerifier(
    { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
    env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
  ),
  audit: new AuditPublisher(nc, logger),
  logger,
  priceBookPath: env('ACP_PRICE_BOOK_PATH', defaultPriceBookPath()),
  // Item 6: online-eval judge scoring. The config gates per-step sampling and
  // names the judge rubric/model class; the judge POSTs scores to the eval
  // service and completes via the LLM gateway. Absent config disables sampling.
  ...(onlineEvalPath === ''
    ? {}
    : { onlineEval: loadOnlineEvalConfig(readFileSync(onlineEvalPath, 'utf8')) }),
  llmGatewayUrl: env('ACP_LLM_GATEWAY_URL', 'http://localhost:7107'),
  evaluationUrl: env('ACP_EVALUATION_URL', 'http://localhost:7108'),
  // Item 5: the pre-dispatch kill-switch checkpoint answers from this in-memory
  // watcher (fast path — routers react within the <10s SLO without polling).
  killSwitch: await KillSwitchWatcher.start(nc, logger),
});

const connection = await NativeConnection.connect({
  address: env('ACP_TEMPORAL_ADDRESS', 'localhost:7233'),
});

const worker = await Worker.create({
  connection,
  namespace: env('ACP_TEMPORAL_NAMESPACE', 'default'),
  taskQueue: CONTROL_TASK_QUEUE,
  workflowsPath: require.resolve('./workflows.js'),
  activities: { ...activities },
  // Workflow code runs in the deterministic isolate; its spans leave via
  // this sink. Without it the workflow-side interceptor cannot run, and
  // the trace would fracture at every workflow→activity edge.
  sinks: {
    exporter: makeWorkflowExporter(
      new LegacyBatchSpanProcessor(
        new LegacyOTLPTraceExporter({
          url: `${env('ACP_OTLP_ENDPOINT', 'http://localhost:4318')}/v1/traces`,
        }),
        { scheduledDelayMillis: 500 },
      ),
      new LegacyResource({ 'service.name': 'orchestrator', 'service.namespace': 'acp' }),
    ),
  },
  interceptors: {
    // One trace across gateway → workflow → agent activity: the OTel
    // interceptors carry W3C context through Temporal headers.
    workflowModules: [
      require.resolve('@temporalio/interceptors-opentelemetry/lib/workflow-interceptors'),
    ],
    activity: [(ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx) })],
  },
});

logger.info({ taskQueue: CONTROL_TASK_QUEUE }, 'orchestrator worker starting');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    worker.shutdown();
  });
}

await worker.run();
await nc.drain();
await telemetry.shutdown();
