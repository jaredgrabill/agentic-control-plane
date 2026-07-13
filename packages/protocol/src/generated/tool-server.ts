/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */

/* eslint-disable */

/**
 * server.json-style publication record for one governed MCP tool server (tool-integration.md): tools with scopes and risk classes, owning team, wrapped system of record, data classification, rate limits, and deprecation. INTERNAL catalog only — it names scope vocabulary and SoR topology, so it is served on authenticated registry routes and never on the public A2A edge. Secrets are NEVER stored: auth.credential_ref is an env/vault KEY NAME expanded at the tool gateway.
 */
export interface ToolServerRecord {
  id: string;
  url: string;
  /**
   * Semver of the published tool contract.
   */
  version: string;
  /**
   * Accountable human team (no ownerless tool servers).
   */
  owning_team: string;
  /**
   * The system of record this server wraps (e.g. the ITSM, the cloud estate).
   */
  wrapped_sor: string;
  data_classification: 'public' | 'internal' | 'confidential' | 'restricted';
  auth: {
    /**
     * credential-ref: the gateway brokers a static credential resolved from credential_ref at startup. token-exchange: RFC 8693 exchange toward audience/scope.
     */
    mode: 'credential-ref' | 'token-exchange';
    /**
     * Env/vault KEY NAME (e.g. ACP_TOOL_CRED_CLOUD_ESTATE) — never the secret value.
     */
    credential_ref?: string;
    /**
     * Header the brokered credential is sent in; defaults to x-acp-broker-credential.
     */
    header?: string;
    audience?: string;
    scope?: string[];
  };
  /**
   * The allowlist AND scope map: a tool absent here cannot be called through the gateway.
   *
   * @minItems 1
   */
  tools: [Tool, ...Tool[]];
  rate_limit: RateLimit;
  /**
   * Per-tool overrides; tools not named fall back to rate_limit.
   */
  tool_rate_limits?: {
    [k: string]: RateLimit;
  };
  deprecation?: {
    deprecated: boolean;
    sunset_at?: string;
    replaced_by?: string;
  };
  timeout_ms?: number;
}
export interface Tool {
  name: string;
  description?: string;
  /**
   * Delegated scope a caller must hold for Cedar to permit the call.
   */
  scope: string;
  /**
   * Side-effect risk: R0 read, R1 draft, R2 write-gated, R3 write-auto.
   */
  risk: 'R0' | 'R1' | 'R2' | 'R3';
  /**
   * JSON Schema 2020-12 for the tool input (informational; the gateway validates live).
   */
  input_schema?: {};
  /**
   * JSON Schema 2020-12 for the tool output (informational; the gateway validates live).
   */
  output_schema?: {};
}
export interface RateLimit {
  per_minute: number;
  burst: number;
}
