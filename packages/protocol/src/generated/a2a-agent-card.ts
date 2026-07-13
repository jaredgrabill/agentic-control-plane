/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */

/* eslint-disable */

/**
 * A2A v1.0 Agent Card wire document — the EXTERNAL projection of a registry agent card (ADR-0006). Produced only by the Registry's strict allowlist translation (toA2ACard): every exported field is opted IN; internal governance fields (tool bindings, scopes, model classes, data classification, compensators, eval baselines, tenants, lifecycle) are never present. signatures[] carry detached JWS (RFC 7797) by the registry signing key, verifiable against the public JWKS.
 */
export interface A2AAgentCard {
  /**
   * A2A protocol version this card conforms to (e.g. 1.0).
   */
  protocolVersion: string;
  name: string;
  description: string;
  /**
   * Public service endpoint for this agent at the platform edge. Documented-inert in v0: card export ships before the inbound execution surface.
   */
  url: string;
  /**
   * v0 exports declare JSON-RPC only.
   */
  preferredTransport: 'JSONRPC';
  provider?: {
    /**
     * Platform organization constant — never the internal owning team.
     */
    organization: string;
    url?: string;
  };
  /**
   * Semver of the exported agent version's capability contract.
   */
  version: string;
  /**
   * A2A optional-feature flags; all false in v0 exports.
   */
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  /**
   * How an EXTERNAL consumer authenticates to the platform edge (e.g. oauth2 client credentials at the platform token endpoint). Never internal scope vocabulary.
   */
  securitySchemes?: {
    [k: string]: {};
  };
  /**
   * Security requirements referencing securitySchemes by name.
   */
  security?: {
    [k: string]: string[];
  }[];
  /**
   * @minItems 1
   */
  defaultInputModes: [string, ...string[]];
  /**
   * @minItems 1
   */
  defaultOutputModes: [string, ...string[]];
  /**
   * @minItems 1
   */
  skills: [Skill, ...Skill[]];
  /**
   * Detached JWS signatures (RFC 7797, b64=false) over the JCS-canonicalized card sans signatures, by the registry signing key.
   */
  signatures?: Signature[];
}
export interface Skill {
  /**
   * Capability name (the platform's namespaced action, e.g. knowledge.search).
   */
  id: string;
  name: string;
  description: string;
  /**
   * Governance hints (e.g. the risk class) — informational for consumers.
   */
  tags: string[];
  /**
   * Example inputs, serialized; drawn from the manifest's discovery examples.
   */
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}
export interface Signature {
  /**
   * Base64url-encoded protected JWS header ({alg, kid, b64:false, crit:[b64]}).
   */
  protected: string;
  /**
   * Base64url-encoded JWS signature over the detached canonical payload.
   */
  signature: string;
}
