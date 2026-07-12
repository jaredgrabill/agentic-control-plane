/**
 * Capability registration with dependencies injected by closure — the
 * CapabilityContext stays exactly what the SDK provides (parity-gated).
 * The capability handlers land in the next commits.
 */

import type { Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';

export interface CapabilityDeps {
  tools: ToolClient;
}

export function registerCapabilities(_agent: Agent, _deps: CapabilityDeps): void {
  // netsec.rule_search / exposure_analysis / change_impact / rule_draft
  // register here as they are implemented.
}
