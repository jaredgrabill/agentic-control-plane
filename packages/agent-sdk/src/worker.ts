/**
 * Temporal worker bootstrap: serves the agent's task queue until cancelled.
 * Needs live Temporal + NATS; the E2E suite covers it (mirrors the Python
 * SDK's `Agent.run()`, which is likewise excluded from unit coverage).
 */

import { OpenTelemetryActivityInboundInterceptor } from '@temporalio/interceptors-opentelemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import { connect, tokenAuthenticator, type NatsConnection } from 'nats';
import type { Agent } from './agent.js';
import { BusTokenSource } from './bus-token.js';
import { GatewayModel } from './gateway-model.js';
import { NatsRetriever, TokenExchanger } from './retriever.js';
import { configureTracing } from './telemetry.js';

/** Env parity with the Python SDK's run(): same variables, same defaults. */
export async function serveAgent(agent: Agent): Promise<void> {
  agent.assertComplete();
  configureTracing(agent.agentId);

  // A served agent with no configured model completes through the LLM
  // Gateway on its manifest's first allowed class (the NatsRetriever
  // precedent). Unit-tested agents keep the FakeModel fallback.
  agent.model ??= new GatewayModel({
    url: process.env.ACP_LLM_GATEWAY_URL ?? 'http://localhost:7107',
    modelClass: agent.manifest.models?.allowed[0] ?? 'default-tier',
  });

  let nc: NatsConnection | undefined;
  let busTokens: BusTokenSource | undefined;
  if (agent.retriever === undefined) {
    const clientSecret = process.env.ACP_AGENT_CLIENT_SECRET;
    if (clientSecret === undefined) {
      throw new Error('ACP_AGENT_CLIENT_SECRET is required to serve an agent');
    }
    const tokenUrl = process.env.ACP_TOKEN_URL ?? 'http://localhost:7101';
    const clientId = process.env.ACP_AGENT_CLIENT_ID ?? `agent-${agent.agentId}`;
    // Item 0c: the bus identity is minted from a platform JWT via the auth
    // callout — no static NATS user. A background refresh keeps the token
    // live; the authenticator's function form re-reads it on every connect
    // attempt, so a reconnect presents a fresh token.
    const source = new BusTokenSource({ tokenUrl, clientId, clientSecret, logger: agent.log });
    busTokens = source;
    await source.start();
    nc = await connect({
      servers: process.env.ACP_NATS_URL ?? 'nats://localhost:4222',
      authenticator: tokenAuthenticator(() => source.token()),
    });
    agent.retriever = new NatsRetriever({
      nc,
      exchanger: new TokenExchanger({ tokenUrl, clientId, clientSecret }),
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
    // Temporal startup failed after we opened NATS: stop the refresh timer
    // and close the connection we own so nothing keeps the process alive.
    busTokens?.stop();
    await nc?.close();
    throw err;
  }
  agent.log.info({ task_queue: agent.taskQueue }, 'agent worker serving');
  await worker.run();
}
