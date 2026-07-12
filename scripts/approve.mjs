/**
 * Approval operator tooling — the human side of the require-approval gate.
 * Approvals carry full context (governance-and-policy.md): an approver sees
 * the plan, blast radius, exact step input, scopes, and compensator (or a red
 * IRREVERSIBLE banner) BEFORE deciding. `approve`/`deny` perform `show` first,
 * so it is structurally impossible to decide without seeing what you decide.
 *
 *   node scripts/approve.mjs list [--tenant acme]
 *   node scripts/approve.mjs show <approval-id>
 *   node scripts/approve.mjs approve <approval-id> [--note "looks safe"]
 *   node scripts/approve.mjs deny <approval-id> --note "blast radius too wide"
 *
 * The approver authenticates as cli-approver (roles [tenant-approver], scopes
 * [approvals:decide, audit:read], deliberately NO task:submit): reading the
 * pending list needs audit:read; show/decide need approvals:decide. Identity
 * is the token's sub — the gateway and workflow both enforce that the approver
 * is not the subject (separation of duties), and echo the subject digest so a
 * changed context is refused.
 */
import console from 'node:console';
import process from 'node:process';

const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const [command, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const positional = args.find((a) => !a.startsWith('--'));

const tokenUrl = process.env.ACP_TOKEN_URL ?? 'http://localhost:7101';
const gatewayUrl = process.env.ACP_GATEWAY_URL ?? 'http://localhost:7100';
const auditUrl = process.env.ACP_AUDIT_URL ?? 'http://localhost:7104';
const clientId = process.env.ACP_APPROVER_CLIENT_ID ?? 'cli-approver';
const clientSecret = process.env.ACP_APPROVER_CLIENT_SECRET ?? 'approver-dev-secret';

async function mint(audience, scope) {
  const res = await fetch(`${tokenUrl}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
      scope,
    }),
  });
  if (!res.ok) {
    console.error(`token service refused approver credentials: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return (await res.json()).access_token;
}

/** Fetches the full approval context from the gateway (source of truth). */
async function fetchApproval(approvalId) {
  const token = await mint('acp:gateway', 'approvals:decide');
  const res = await fetch(`${gatewayUrl}/v1/approvals/${approvalId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    console.error(`no approval ${approvalId} in your tenant (missing, decided, or cross-tenant)`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`gateway refused the approval lookup: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

/** Prints the full decision context — the IRREVERSIBLE banner is unmissable. */
function printApproval(view) {
  const s = view.subject;
  console.log('='.repeat(64));
  console.log(`Approval ${view.approval_id}   status: ${view.status}`);
  console.log('='.repeat(64));
  if (s.irreversible === true) {
    console.log(
      `${RED}${BOLD}  !!! IRREVERSIBLE WRITE — no compensator declared !!!  ${RESET}`,
    );
  }
  console.log(`  capability:   ${s.capability}   (risk ${s.risk})`);
  console.log(`  agent:        ${s.agent_id}@${s.agent_version}`);
  console.log(`  principal:    ${s.principal}   (tenant ${s.tenant})`);
  console.log(`  task / step:  ${s.task_id} / ${s.step_id}`);
  console.log(`  scopes:       ${(s.requested_scopes ?? []).join(', ') || '(none)'}`);
  console.log(
    `  reversible:   ${s.compensator !== undefined ? `yes — compensator ${s.compensator}` : `${RED}NO${RESET}`}`,
  );
  console.log(`  requested_at: ${view.requested_at}   escalated: ${view.escalated}`);
  console.log('\n  step input (exactly what will run):');
  console.log(indent(JSON.stringify(s.input ?? {}, null, 2), 4));
  console.log('\n  plan (blast radius):');
  console.log(indent(JSON.stringify(s.plan ?? {}, null, 2), 4));
  console.log(`\n  subject_digest: ${view.subject_digest}`);
  console.log('='.repeat(64));
}

const indent = (text, n) =>
  text
    .split('\n')
    .map((line) => `${' '.repeat(n)}${line}`)
    .join('\n');

async function decide(approvalId, decision, note) {
  // Show first — approving/denying without seeing the context is structurally
  // impossible, and we echo the exact digest we displayed.
  const view = await fetchApproval(approvalId);
  printApproval(view);
  if (view.status !== 'pending') {
    console.error(`\napproval ${approvalId} is already ${view.status} — nothing to do`);
    process.exit(1);
  }

  const token = await mint('acp:gateway', 'approvals:decide');
  const res = await fetch(`${gatewayUrl}/v1/approvals/${approvalId}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      decision,
      subject_digest: view.subject_digest,
      ...(note !== undefined ? { note } : {}),
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`\ndecision refused: ${res.status} ${body}`);
    process.exit(1);
  }
  const { decision_id } = JSON.parse(body);
  console.log(`\n${decision === 'approve' ? 'APPROVED' : 'DENIED'} ${approvalId} (decision ${decision_id})`);
}

async function list(tenant) {
  const token = await mint('acp:audit', 'audit:read');
  const query = new URLSearchParams({ tenant, limit: '1000' });
  const res = await fetch(`${auditUrl}/v1/events?${query.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`audit query failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { events } = await res.json();

  // Fold: approval.requested minus any terminal event for the same approval_id.
  const terminal = new Set();
  const requested = new Map();
  for (const e of events) {
    const id = e.details?.approval_id;
    if (id === undefined) continue;
    if (e.event_type === 'approval.requested') requested.set(id, e);
    else if (['approval.granted', 'approval.denied', 'approval.timeout'].includes(e.event_type)) {
      terminal.add(id);
    }
  }
  const pending = [...requested.values()].filter((e) => !terminal.has(e.details.approval_id));

  console.log(`Pending approvals — tenant ${tenant}: ${pending.length}`);
  if (pending.length === 0) return;
  console.log('-'.repeat(72));
  for (const e of pending) {
    const d = e.details;
    const flagBits = [d.irreversible === true ? `${RED}IRREVERSIBLE${RESET}` : null]
      .filter(Boolean)
      .join(' ');
    console.log(
      `  ${d.approval_id}  ${String(d.capability).padEnd(20)} risk ${d.risk}  ` +
        `${d.principal}  ${flagBits}`,
    );
  }
  console.log('\nRun: node scripts/approve.mjs show <approval-id>');
}

switch (command) {
  case 'list':
    await list(flag('--tenant', 'acme'));
    break;
  case 'show': {
    if (positional === undefined) usage();
    printApproval(await fetchApproval(positional));
    break;
  }
  case 'approve': {
    if (positional === undefined) usage();
    await decide(positional, 'approve', flag('--note', undefined));
    break;
  }
  case 'deny': {
    const note = flag('--note', undefined);
    if (positional === undefined || note === undefined) {
      console.error('deny requires an approval id and a --note explaining why');
      process.exit(2);
    }
    await decide(positional, 'deny', note);
    break;
  }
  default:
    usage();
}

function usage() {
  console.error(
    'usage:\n' +
      '  node scripts/approve.mjs list [--tenant acme]\n' +
      '  node scripts/approve.mjs show <approval-id>\n' +
      '  node scripts/approve.mjs approve <approval-id> [--note "..."]\n' +
      '  node scripts/approve.mjs deny <approval-id> --note "..."\n' +
      'approve/deny show the full context first and echo the displayed digest.',
  );
  process.exit(2);
}
