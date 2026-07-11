/**
 * CapabilityContext: everything a handler may touch. Handlers are stateless
 * between invocations — all state arrives here or lives in platform stores
 * (agent-patterns.md).
 */

import type { Budget } from '@acp/protocol';
import type { Logger } from 'pino';
import type { ModelClient } from './model.js';
import type { Retriever } from './retriever.js';

export class CapabilityContext {
  readonly tenant: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly capability: string;
  readonly delegatedToken: string | undefined;
  readonly budget: Budget | undefined;
  readonly model: ModelClient;
  readonly log: Logger;
  private readonly retriever: Retriever | undefined;

  constructor(fields: {
    tenant: string;
    taskId: string;
    stepId: string;
    capability: string;
    delegatedToken: string | undefined;
    budget: Budget | undefined;
    model: ModelClient;
    retriever: Retriever | undefined;
    log: Logger;
  }) {
    this.tenant = fields.tenant;
    this.taskId = fields.taskId;
    this.stepId = fields.stepId;
    this.capability = fields.capability;
    this.delegatedToken = fields.delegatedToken;
    this.budget = fields.budget;
    this.model = fields.model;
    this.retriever = fields.retriever;
    this.log = fields.log;
  }

  /** Citation-carrying retrieval under the step's delegated identity. `k` defaults to 8. */
  retrieve(query: string, options: { k?: number } = {}): Promise<Record<string, unknown>[]> {
    if (this.retriever === undefined) {
      return Promise.reject(
        new Error(
          "no retriever configured — pass one to Agent(...) or use the eval harness's" +
            ' fixture retriever in tests',
        ),
      );
    }
    if (this.delegatedToken === undefined) {
      return Promise.reject(
        new Error('step carries no delegated token — retrieval requires the delegated identity'),
      );
    }
    return this.retriever.search(this.delegatedToken, query, {
      k: options.k ?? 8,
      taskId: this.taskId,
      stepId: this.stepId,
    });
  }
}
