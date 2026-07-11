import process from 'node:process';
import { createRequire } from 'node:module';
import {
  AuditPublisher,
  connectBus,
  createLogger,
  ensureAuditStream,
  env,
  initTelemetry,
} from '@acp/service-kit';
import { OpenTelemetryActivityInboundInterceptor } from '@temporalio/interceptors-opentelemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
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

const activities = createControlActivities({
  registryUrl: env('ACP_REGISTRY_URL', 'http://localhost:7102'),
  policyUrl: env('ACP_POLICY_URL', 'http://localhost:7103'),
  tokenUrl: env('ACP_TOKEN_URL', 'http://localhost:7101'),
  clientId: env('ACP_ORCHESTRATOR_CLIENT_ID', 'svc-orchestrator'),
  clientSecret: env('ACP_ORCHESTRATOR_CLIENT_SECRET', 'orchestrator-dev-secret'),
  audit: new AuditPublisher(nc, logger),
  logger,
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
  interceptors: {
    // One trace across gateway → workflow → agent activity: the OTel
    // interceptors carry W3C context through Temporal headers.
    workflowModules: [require.resolve('@temporalio/interceptors-opentelemetry/lib/workflow')],
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
