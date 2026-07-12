/**
 * Capability registration with dependencies injected by closure — the
 * CapabilityContext stays exactly what the SDK provides (parity-gated).
 */

import type { Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { registerConflictCheck } from './conflict-check.js';
import { registerDraft } from './draft.js';
import { registerSubmit } from './submit.js';
import { registerWithdraw } from './withdraw.js';

export interface CapabilityDeps {
  tools: ToolClient;
}

export function registerCapabilities(agent: Agent, deps: CapabilityDeps): void {
  registerConflictCheck(agent, deps.tools);
  registerDraft(agent, deps.tools);
  registerSubmit(agent, deps.tools);
  registerWithdraw(agent, deps.tools);
}
