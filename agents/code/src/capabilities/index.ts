/**
 * Capability registration with dependencies injected by closure — the
 * CapabilityContext stays exactly what the SDK provides (parity-gated).
 */

import type { Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { registerCiHealth } from './ci-health.js';
import { registerDependencyQuery } from './dependency-query.js';

export interface CapabilityDeps {
  tools: ToolClient;
}

export function registerCapabilities(agent: Agent, deps: CapabilityDeps): void {
  registerDependencyQuery(agent, deps.tools);
  registerCiHealth(agent, deps.tools);
}
