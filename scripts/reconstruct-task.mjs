/**
 * Forensic task reconstruction CLI (item 5, Audit v1).
 *
 * Assembles the full narrative of a task from the audit ledger — submission,
 * plan, each step's dispatch/policy/approval/tokens/tool-calls/outcome, the
 * compensation unwind, and the terminal result — from records read in chain_seq
 * order (the total order the hash chain attests). This is assembly, not
 * re-execution.
 *
 *   node scripts/reconstruct-task.mjs <task_id> [--tenant <t>] [--json]
 *
 * Authenticates as svc-ci for an acp:audit / audit:read token (dev defaults).
 */
import console from 'node:console';
import process from 'node:process';

const [taskId, ...rest] = process.argv.slice(2);
const tenantIdx = rest.indexOf('--tenant');
const tenant = tenantIdx >= 0 ? rest[tenantIdx + 1] : 'acme';
const asJson = rest.includes('--json');

if (taskId === undefined) {
  console.error('usage: node scripts/reconstruct-task.mjs <task_id> [--tenant <t>] [--json]');
  process.exit(2);
}

const tokenUrl = process.env.ACP_TOKEN_URL ?? 'http://localhost:7101';
const auditUrl = process.env.ACP_AUDIT_URL ?? 'http://localhost:7104';
const clientId = process.env.ACP_ADMIN_CLIENT_ID ?? 'svc-ci';
const clientSecret = process.env.ACP_ADMIN_CLIENT_SECRET ?? 'ci-dev-secret';

const tokenRes = await fetch(`${tokenUrl}/v1/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    audience: 'acp:audit',
    scope: 'audit:read',
  }),
});
if (!tokenRes.ok) {
  console.error(
    `token service refused audit credentials: ${tokenRes.status} ${await tokenRes.text()}`,
  );
  process.exit(1);
}
const { access_token } = await tokenRes.json();

const res = await fetch(
  `${auditUrl}/v1/tasks/${encodeURIComponent(taskId)}/reconstruction?tenant=${encodeURIComponent(tenant)}`,
  { headers: { authorization: `Bearer ${access_token}` } },
);
if (res.status === 404) {
  console.error(`no task ${taskId} in tenant ${tenant}`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`reconstruction failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const recon = await res.json();

if (asJson) {
  console.log(JSON.stringify(recon, null, 2));
  process.exit(0);
}

// Human-readable summary.
console.log(`Task ${recon.task_id} (tenant ${recon.tenant})`);
console.log(
  `  integrity: ${recon.integrity.records} records` +
    (recon.integrity.span
      ? `, chain_seq ${recon.integrity.span.from_seq}..${recon.integrity.span.to_seq}`
      : '') +
    (recon.truncated ? ' (TRUNCATED)' : ''),
);
if (recon.submitted)
  console.log(`  submitted by ${recon.submitted.actor} at ${recon.submitted.at}`);
if (recon.plan)
  console.log(
    `  plan: ${recon.plan.planner ?? 'unknown'} (${recon.plan.plan_digest ?? 'no digest'})`,
  );
for (const step of recon.steps ?? []) {
  const status = step.completed?.status ?? (step.skipped ? 'skipped' : 'pending');
  const agent = step.agent ? `${step.agent.id ?? '?'}@${step.agent.version ?? '?'}` : '?';
  console.log(`  step ${step.capability ?? step.step_id} → ${agent}: ${status}`);
  if (step.approval)
    console.log(`    approval: ${step.approval.status} by ${step.approval.approver ?? '—'}`);
  for (const call of step.tool_calls ?? []) {
    console.log(
      `    tool: ${call.server}/${call.tool} → ${call.outcome}${call.refusal ? ` (${call.refusal})` : ''}`,
    );
  }
  if (step.skipped) console.log(`    skipped: ${step.skipped.gap ?? ''}`);
}
if (recon.compensation) console.log(`  compensation: ${JSON.stringify(recon.compensation)}`);
if (recon.cancellation)
  console.log(
    `  cancelled: trigger=${recon.cancellation.trigger ?? '—'} by ${recon.cancellation.actor}`,
  );
if (recon.outcome) console.log(`  outcome: ${recon.outcome.status}`);
