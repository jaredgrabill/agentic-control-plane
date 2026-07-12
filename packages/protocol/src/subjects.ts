import { subjectsData } from './generated/subjects-data.js';

const TOKEN_RE = /^[a-z0-9_.-]+$/;

/**
 * Validates a single subject token. NATS treats `.`, `*`, and `>` as
 * structural; letting caller-supplied IDs smuggle them in would let a tenant
 * widen its own subscription — so this throws rather than sanitizes.
 * (`event_type` values like `task.submitted` are multi-token by design and
 * are validated against the closed vocabulary instead.)
 */
function checkToken(name: string, value: string): string {
  if (!TOKEN_RE.test(value) || value.includes('..')) {
    throw new Error(
      `invalid subject token ${name}=${JSON.stringify(value)}: must match ${TOKEN_RE.source}`,
    );
  }
  return value;
}

function checkVerb(entity: keyof typeof subjectsData.entities, verb: string): string {
  const verbs: readonly string[] = subjectsData.entities[entity].verbs;
  if (!verbs.includes(verb)) {
    throw new Error(
      `unknown ${entity} verb ${JSON.stringify(verb)}: closed vocabulary is [${verbs.join(', ')}]`,
    );
  }
  return verb;
}

export type TaskVerb = (typeof subjectsData.entities.task.verbs)[number];
export type AgentVerb = (typeof subjectsData.entities.agent.verbs)[number];
export type RegistryVerb = (typeof subjectsData.entities.registry.verbs)[number];
export type ControlVerb = (typeof subjectsData.entities.control.verbs)[number];
export type SvcName = (typeof subjectsData.entities.svc.services)[number];

export const subjects = {
  task(tenant: string, taskId: string, verb: TaskVerb): string {
    return `acp.${checkToken('tenant', tenant)}.task.${checkToken('task_id', taskId)}.${checkVerb('task', verb)}`;
  },
  agent(tenant: string, agentId: string, verb: AgentVerb): string {
    return `acp.${checkToken('tenant', tenant)}.agent.${checkToken('agent_id', agentId)}.${checkVerb('agent', verb)}`;
  },
  audit(tenant: string, eventType: string): string {
    // event_type is validated against the closed enum in the audit-event
    // schema; the subject uses it verbatim (dots become subject tokens).
    if (!/^[a-z_]+(\.[a-z_]+)+$/.test(eventType)) {
      throw new Error(`invalid audit event_type ${JSON.stringify(eventType)}`);
    }
    return `acp.${checkToken('tenant', tenant)}.audit.${eventType}`;
  },
  auditCorpus(tenant: string, sourceId: string): string {
    return `acp.${checkToken('tenant', tenant)}.audit.corpus.${checkToken('source_id', sourceId)}`;
  },
  ingest(tenant: string, sourceId: string): string {
    return `acp.${checkToken('tenant', tenant)}.ingest.${checkToken('source_id', sourceId)}`;
  },
  telemetry(tenant: string, signal: string): string {
    return `acp.${checkToken('tenant', tenant)}.telemetry.${checkToken('signal', signal)}`;
  },
  registry(agentId: string, verb: RegistryVerb): string {
    return `acp.platform.registry.${checkToken('agent_id', agentId)}.${checkVerb('registry', verb)}`;
  },
  control(verb: ControlVerb): string {
    return `acp.platform.control.${checkVerb('control', verb)}`;
  },
  svc(service: SvcName, method: string): string {
    const services: readonly string[] = subjectsData.entities.svc.services;
    if (!services.includes(service)) {
      throw new Error(
        `unknown platform service ${JSON.stringify(service)}: closed vocabulary is [${services.join(', ')}]`,
      );
    }
    return `acp.platform.svc.${service}.${checkToken('method', method)}`;
  },
} as const;
