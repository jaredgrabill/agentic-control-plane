/**
 * Synthetic-prober control (item 6). Starts or stops the singleton
 * ProbeWorkflow (workflowId `synthetic-prober`) on the orchestrator's
 * `acp-tasks` queue. The workflow reads its probe suite + cadence from the
 * argument passed here (deploy/dev/online-eval.json → probes section), runs
 * every case through a REAL TaskWorkflow child each cycle, and records a
 * deterministic known-answer result to the eval service.
 *
 *   node scripts/probes.mjs start   # idempotent — a second start is a no-op
 *   node scripts/probes.mjs stop
 *
 * run-platform auto-starts it after readiness.
 */
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Client, Connection } from '@temporalio/client';

const PROBER_WORKFLOW_ID = 'synthetic-prober';
const TASK_QUEUE = 'acp-tasks';

const address = process.env.ACP_TEMPORAL_ADDRESS ?? 'localhost:7233';
const namespace = process.env.ACP_TEMPORAL_NAMESPACE ?? 'default';
const configPath = process.env.ACP_ONLINE_EVAL;

async function client() {
  const connection = await Connection.connect({ address });
  return new Client({ connection, namespace });
}

async function start() {
  if (configPath === undefined) {
    console.error('ACP_ONLINE_EVAL (path to online-eval.json) is required to start the prober');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const input = {
    interval_s: config.probes.interval_s,
    probe_failure_weight: config.probes.probe_failure_weight,
    targets: config.probes.targets,
    cycle: 0,
  };
  const c = await client();
  try {
    await c.workflow.start('ProbeWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: PROBER_WORKFLOW_ID,
      args: [input],
    });
    console.log(
      `started ${PROBER_WORKFLOW_ID} (${input.targets.length} target(s), every ${input.interval_s}s)`,
    );
  } catch (err) {
    // WorkflowExecutionAlreadyStartedError → the singleton is already running.
    if (String(err).includes('AlreadyStarted') || String(err).includes('already')) {
      console.log(`${PROBER_WORKFLOW_ID} already running`);
    } else {
      throw err;
    }
  }
  await c.connection.close();
}

async function stop() {
  const c = await client();
  try {
    await c.workflow.getHandle(PROBER_WORKFLOW_ID).terminate('operator stop');
    console.log(`stopped ${PROBER_WORKFLOW_ID}`);
  } catch (err) {
    console.log(`nothing to stop (${String(err).slice(0, 80)})`);
  }
  await c.connection.close();
}

const [command] = process.argv.slice(2);
if (command === 'start') await start();
else if (command === 'stop') await stop();
else {
  console.error('usage: probes.mjs start|stop');
  process.exit(2);
}
