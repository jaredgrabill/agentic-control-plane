/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */

/* eslint-disable */

/**
 * Full lifecycle vocabulary (agent-lifecycle.md). Registry v0 transitions only among registered/active/suspended; the rest arrive with the Deployment Controller.
 */
export type LifecycleState =
  'registered' | 'shadow' | 'canary' | 'active' | 'deprecated' | 'suspended' | 'retired';

/**
 * Registry record for one agent version: the team-authored manifest plus platform-managed fields added at registration. A superset of an A2A agent card; card_signature is a JWS over the identity content so consumers can verify provenance.
 */
export interface AgentCard {
  manifest: AgentManifest;
  /**
   * Semver of the capability contract, not the implementation.
   */
  version: string;
  lifecycle_state: LifecycleState;
  /**
   * Scores the current active version achieves; gates are relative to this.
   */
  eval_baseline?: {};
  registered_at: string;
  updated_at: string;
  deployed_at?: string;
  /**
   * Why the record is in its current state (e.g. kill-switch reason).
   */
  state_reason?: string;
  /**
   * Compact JWS over the canonical identity content: {manifest, version, registered_at}. Lifecycle changes do not re-sign.
   */
  card_signature: string;
}
/**
 * Capability manifest authored by an agent team and versioned in git. A superset of an A2A-compatible agent card; the Registry adds platform-managed fields at registration.
 */
export interface AgentManifest {
  /**
   * Stable agent identifier (kebab-case).
   */
  id: string;
  name: string;
  /**
   * Accountable human team (required — no ownerless agents).
   */
  owner: string;
  description: string;
  /**
   * @minItems 1
   */
  capabilities: [Capability, ...Capability[]];
  /**
   * MCP servers this agent may bind. Absent means no tool access.
   */
  tools?: ToolBinding[];
  models?: {
    /**
     * Model classes (e.g. default-tier), never hard-coded model IDs.
     *
     * @minItems 1
     */
    allowed: [string, ...string[]];
  };
  data_classification?: 'public' | 'internal' | 'confidential' | 'restricted';
  sla?: {
    p95_latency_s?: number;
    quality_slo?: number;
  };
}
export interface Capability {
  /**
   * Namespaced narrow action, e.g. knowledge.search.
   */
  name: string;
  description: string;
  /**
   * Side-effect risk: R0 read, R1 draft, R2 write-gated, R3 write-auto.
   */
  risk: 'R0' | 'R1' | 'R2' | 'R3';
  /**
   * JSON Schema 2020-12 for the capability input.
   */
  input_schema: {};
  /**
   * JSON Schema 2020-12 for the capability output.
   */
  output_schema: {};
  /**
   * At least 3; used for semantic discovery and eval seeds.
   *
   * @minItems 3
   */
  examples: [
    {
      input: {};
      output?: {};
      description?: string;
    },
    {
      input: {};
      output?: {};
      description?: string;
    },
    {
      input: {};
      output?: {};
      description?: string;
    },
    ...{
      input: {};
      output?: {};
      description?: string;
    }[]
  ];
  /**
   * Compensating capability for R2+ writes (e.g. change.submit ⇄ change.withdraw). R2/R3 capabilities MUST declare a compensator or irreversible:true — enforced at registration, where the rejection carries an operator-actionable message (conditional JSON Schema keywords do not survive both language bindings).
   */
  compensator?: string;
  /**
   * Declares an R2+ capability has no compensator; raises approval requirements.
   */
  irreversible?: boolean;
  /**
   * Relaxed eval-baseline requirements; shadow-only routing.
   */
  experimental?: boolean;
  sla?: {
    p95_latency_s?: number;
  };
}
export interface ToolBinding {
  server: string;
  /**
   * @minItems 1
   */
  scopes: [string, ...string[]];
}
