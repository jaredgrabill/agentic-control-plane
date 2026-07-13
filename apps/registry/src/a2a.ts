/**
 * A2A v1.0 card export (ADR-0006): the STRICT allowlist projection from an
 * internal AgentCard to the external A2A wire card, plus detached-JWS
 * signing/verification with the registry signing key.
 *
 * Leak prevention is the design center: every exported field is opted IN
 * here, field by field. The following are NEVER exported (each names an
 * internal-topology or governance leak): manifest.tools (SoR topology +
 * internal scope vocabulary), models.allowed, data_classification,
 * capability compensator/irreversible (saga wiring), eval_baseline,
 * lifecycle_state/state_reason, tenant, sla, and the manifest owner (the
 * provider is a platform org constant). The generated A2AAgentCard schema is
 * additionalProperties:false, and toA2ACard re-parses its own output against
 * it, so an accidental field addition fails closed at translation time.
 */

import {
  a2aAgentCard,
  type A2AAgentCard,
  type AgentCard,
  type Capability,
} from '@acp/protocol';
import { stableStringify } from '@acp/service-kit';
import {
  createLocalJWKSet,
  FlattenedSign,
  flattenedVerify,
  type CryptoKey,
  type JSONWebKeySet,
} from 'jose';

export interface A2ACardOptions {
  /** Public platform edge base URL (the gateway) — never an internal service URL. */
  edgeBaseUrl: string;
  /** Platform organization constant — never the manifest's owning team. */
  providerOrg: string;
  providerUrl?: string | undefined;
  /** Public token endpoint external consumers authenticate at (client credentials). */
  tokenUrl: string;
}

export const A2A_PROTOCOL_VERSION = '1.0';
const SECURITY_SCHEME = 'platform-oauth2';
const EDGE_SCOPE = 'task:submit';
const JSON_MODE = 'application/json';

/**
 * Pure allowlist translation: internal AgentCard → unsigned A2A card. No
 * secrets, no signature — signing is a separate concern (signA2ACard).
 */
export function toA2ACard(card: AgentCard, opts: A2ACardOptions): A2AAgentCard {
  const manifest = card.manifest;
  // The manifest schema guarantees ≥1 capability; the assertion carries that
  // to the generated tuple type ([Skill, ...Skill[]]).
  const skills = manifest.capabilities.map(toSkill) as A2AAgentCard['skills'];
  const projected: A2AAgentCard = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: manifest.name,
    description: manifest.description,
    // The gateway's per-agent A2A door. Documented-inert in v0: the card
    // ships before any inbound execution surface exists.
    url: `${opts.edgeBaseUrl.replace(/\/$/, '')}/v1/a2a/agents/${manifest.id}`,
    preferredTransport: 'JSONRPC',
    provider: {
      organization: opts.providerOrg,
      ...(opts.providerUrl === undefined ? {} : { url: opts.providerUrl }),
    },
    version: card.version,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    // How an EXTERNAL consumer authenticates to US at the edge — not the
    // internal delegated-scope vocabulary.
    securitySchemes: {
      [SECURITY_SCHEME]: {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: `${opts.tokenUrl.replace(/\/$/, '')}/v1/token`,
            scopes: { [EDGE_SCOPE]: 'Submit tasks to the platform edge' },
          },
        },
      },
    },
    security: [{ [SECURITY_SCHEME]: [EDGE_SCOPE] }],
    defaultInputModes: [JSON_MODE],
    defaultOutputModes: [JSON_MODE],
    skills,
  };
  // Fail closed: the projection must itself conform to the strict external
  // schema (additionalProperties:false), so a leaked field is a thrown
  // ProtocolValidationError, never a served card.
  return a2aAgentCard.parse(projected);
}

function toSkill(capability: Capability): A2AAgentCard['skills'][number] {
  return {
    id: capability.name,
    name: capability.name,
    description: capability.description,
    // The risk class as a governance hint; compensator/irreversible stay
    // internal (saga wiring).
    tags: [capability.risk],
    examples: capability.examples.map((example) => JSON.stringify(example.input)),
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
  };
}

/** Canonical detached signing payload: the JCS-style card bytes sans signatures. */
export function a2aSigningPayload(card: A2AAgentCard): Uint8Array {
  const { signatures: _signatures, ...unsigned } = card;
  return new TextEncoder().encode(stableStringify(unsigned));
}

/**
 * Re-signs the external projection with the registry key as a DETACHED JWS
 * (RFC 7797, b64:false): the internal card_signature covers the internal
 * identity content, not the A2A wire bytes, and must never ship externally.
 * Verifiable against the public /.well-known/jwks.json.
 */
export async function signA2ACard(
  key: { kid: string; privateKey: CryptoKey },
  card: A2AAgentCard,
): Promise<A2AAgentCard> {
  const jws = await new FlattenedSign(a2aSigningPayload(card))
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, b64: false, crit: ['b64'] })
    .sign(key.privateKey);
  return {
    ...card,
    signatures: [{ protected: jws.protected ?? '', signature: jws.signature }],
  };
}

/** Verifies a signed A2A card's first signature against the registry JWKS. */
export async function verifyA2ACard(card: A2AAgentCard, jwks: JSONWebKeySet): Promise<boolean> {
  const signature = card.signatures?.[0];
  if (signature === undefined) return false;
  try {
    await flattenedVerify(
      {
        protected: signature.protected,
        signature: signature.signature,
        payload: a2aSigningPayload(card),
      },
      createLocalJWKSet(jwks),
    );
    return true;
  } catch {
    return false;
  }
}
