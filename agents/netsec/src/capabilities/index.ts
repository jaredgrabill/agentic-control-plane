/**
 * Capability registration with dependencies injected by closure — the
 * CapabilityContext stays exactly what the SDK provides (parity-gated).
 */

import type { Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { registerChangeImpact } from './change-impact.js';
import { registerExposureAnalysis } from './exposure-analysis.js';
import { registerRuleDraft } from './rule-draft.js';
import { registerRuleSearch } from './rule-search.js';

export interface CapabilityDeps {
  tools: ToolClient;
}

export function registerCapabilities(agent: Agent, deps: CapabilityDeps): void {
  registerRuleSearch(agent, deps.tools);
  registerExposureAnalysis(agent, deps.tools);
  registerChangeImpact(agent, deps.tools);
  registerRuleDraft(agent, deps.tools);
}
