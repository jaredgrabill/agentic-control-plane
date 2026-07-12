import { isAuthorized, type EntityJson } from '@cedar-policy/cedar-wasm/nodejs';
import type { Logger } from '@acp/service-kit';
import type { PolicyBundle } from './bundle.js';

export interface EntityRef {
  type: 'User' | 'Service' | 'Agent' | 'Corpus';
  id: string;
  attrs?: Record<string, unknown> | undefined;
}

export interface AuthzRequest {
  principal: EntityRef;
  action: string;
  resource: EntityRef;
  context?: Record<string, unknown> | undefined;
}

export interface AuthzDecision {
  decision: 'allow' | 'deny' | 'require-approval';
  bundle_version: string;
  determining_policies: string[];
}

/**
 * Cedar policy decision point. Default deny is structural: no permit → deny,
 * and any evaluation failure (parse error, bad entity, engine error) is also
 * deny — a broken policy bundle must never fail open.
 */
export class CedarPdp {
  constructor(
    private readonly bundle: PolicyBundle,
    private readonly logger: Logger,
  ) {}

  get bundleVersion(): string {
    return this.bundle.version;
  }

  get policyIds(): string[] {
    return Object.keys(this.bundle.policies);
  }

  authorize(request: AuthzRequest): AuthzDecision {
    const answer = isAuthorized({
      principal: { type: request.principal.type, id: request.principal.id },
      action: { type: 'Action', id: request.action },
      resource: { type: request.resource.type, id: request.resource.id },
      context: (request.context ?? {}) as never,
      policies: { staticPolicies: this.bundle.policies },
      entities: [toEntity(request.principal), toEntity(request.resource)],
    });

    if (answer.type === 'failure') {
      this.logger.error(
        { errors: answer.errors.map((e) => e.message), request },
        'cedar evaluation failed — failing closed (deny)',
      );
      return {
        decision: 'deny',
        bundle_version: this.bundle.version,
        determining_policies: [],
      };
    }
    if (answer.response.diagnostics.errors.length > 0) {
      this.logger.error(
        { errors: answer.response.diagnostics.errors, request },
        'cedar policy errors during evaluation',
      );
    }
    const determining = answer.response.diagnostics.reason;
    if (answer.response.decision !== 'allow') {
      // Cedar deny (forbid, no permit): annotations never rescue a deny.
      return {
        decision: 'deny',
        bundle_version: this.bundle.version,
        determining_policies: determining,
      };
    }
    // Three-way lift, restrictive tie-break: a Cedar allow becomes
    // require-approval if ANY policy that determined it carries
    // @decision("require-approval"). A later broad plain permit cannot
    // silently bypass a gate that also matched — the annotated permit wins.
    const gated = determining.some((id) => this.bundle.approvalPolicies.has(id));
    return {
      decision: gated ? 'require-approval' : 'allow',
      bundle_version: this.bundle.version,
      determining_policies: determining,
    };
  }
}

function toEntity(ref: EntityRef): EntityJson {
  return {
    uid: { type: ref.type, id: ref.id },
    attrs: (ref.attrs ?? {}) as EntityJson['attrs'],
    parents: [],
  };
}
