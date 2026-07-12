/**
 * Capability registration with dependencies injected by closure — the
 * CapabilityContext stays exactly what the SDK provides (parity-gated).
 */

import type { Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { registerCostAnalysis } from './cost-analysis.js';
import { registerInventoryQuery } from './inventory-query.js';

export interface CapabilityDeps {
  tools: ToolClient;
}

export function registerCapabilities(agent: Agent, deps: CapabilityDeps): void {
  registerInventoryQuery(agent, deps.tools);
  registerCostAnalysis(agent, deps.tools);
}
