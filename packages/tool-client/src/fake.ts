/**
 * FakeToolClient: scripted, recording ToolClient for handler unit tests —
 * no MCP, no network. Handlers may throw CapabilityError to exercise the
 * typed-failure paths.
 */

import type { ToolClient, ToolResponse } from './types.js';

export type FakeToolHandler = (
  args: Record<string, unknown>,
) => ToolResponse | Promise<ToolResponse>;

export class FakeToolClient implements ToolClient {
  /** Every call, in order — assert on counts and arguments. */
  readonly calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
  private readonly handlers: Record<string, FakeToolHandler>;

  /** Handlers are keyed `${server}.${tool}`. */
  constructor(handlers: Record<string, FakeToolHandler>) {
    this.handlers = handlers;
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    this.calls.push({ server, tool, args });
    const handler = this.handlers[`${server}.${tool}`];
    if (handler === undefined) {
      throw new Error(`FakeToolClient has no handler for ${server}.${tool}`);
    }
    return await handler(args);
  }
}
