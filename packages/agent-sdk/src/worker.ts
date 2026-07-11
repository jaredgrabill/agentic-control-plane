/**
 * Temporal worker bootstrap: serves the agent's task queue until cancelled.
 * Needs live Temporal + NATS; the E2E suite covers it (mirrors the Python
 * SDK's `Agent.run()`, which is likewise excluded from unit coverage).
 */

import { OpenTelemetryActivityInboundInterceptor } from '@temporalio/interceptors-opentelemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import { connect, type NatsConnection } from 'nats';
import type { Agent } from './agent.js';
import { NatsRetriever, TokenExchanger } from './retriever.js';
import { configureTracing } from './telemetry.js';

/** Env parity with the Python SDK's run(): same variables, same defaults. */
export async function serveAgent(agent: Agent): Promise<void> {
  agent.assertComplete();
  configureTracing(agent.agentId);

  let nc: NatsConnection | undefined;
  if (agent.retriever === undefined) {
    const clientSecret = process.env.ACP_AGENT_CLIENT_SECRET;
    if (clientSecret === undefined) {
      throw new Error('ACP_AGENT_CLIENT_SECRET is required to serve an agent');
    }
    nc = await connect({
      servers: process.env.ACP_NATS_URL ?? 'nats://localhost:4222',
      user: process.env.ACP_NATS_AGENT_USER ?? 'agent-knowledge',
      pass: process.env.ACP_NATS_AGENT_PASSWORD ?? 'agent-knowledge-dev-password',
    });
    agent.retriever = new NatsRetriever({
      nc,
      exchanger: new TokenExchanger({
        tokenUrl: process.env.ACP_TOKEN_URL ?? 'http://localhost:7101',
        clientId: process.env.ACP_AGENT_CLIENT_ID ?? `agent-${agent.agentId}`,
        clientSecret,
      }),
    });
  }

  let worker: Worker;
  try {
    const connection = await NativeConnection.connect({
      address: process.env.ACP_TEMPORAL_ADDRESS ?? 'localhost:7233',
    });

    worker = await Worker.create({
      connection,
      namespace: process.env.ACP_TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: agent.taskQueue,
      // The activity name `execute_capability` IS the polyglot contract with
      // the orchestrator (apps/orchestrator/src/types.ts).
      activities: {
        execute_capability: (request: unknown) => agent.execute(request),
      },
      interceptors: {
        // One trace across gateway → workflow → agent activity: the OTel
        // interceptor carries W3C context through Temporal headers.
        activity: [(ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx) })],
      },
    });
  } catch (err) {
    // Temporal startup failed after we opened NATS: close the connection we
    // own so its socket doesn't keep the process alive.
    await nc?.close();
    throw err;
  }
  agent.log.info({ task_queue: agent.taskQueue }, 'agent worker serving');
  await worker.run();
}
