/**
 * Typed capability failures (agent-patterns.md): the orchestrator's behavior
 * differs per class, and misclassifying errors as retryable is how retry
 * storms happen.
 */

import type { CapabilityError as CapabilityErrorBody } from '@acp/protocol';

/**
 * The closed error-class vocabulary, derived from the generated protocol
 * type so schema drift breaks this build instead of production dispatch.
 */
export type ErrorClass = CapabilityErrorBody['class'];

/** Named constants over the wire values, mirroring Python's `ErrorClass` StrEnum. */
export const ErrorClass = {
  Retryable: 'retryable',
  Permanent: 'permanent',
  BudgetExhausted: 'budget_exhausted',
  PolicyDenied: 'policy_denied',
  NeedsInput: 'needs_input',
} as const satisfies Record<string, ErrorClass>;

/**
 * Throw from a handler to fail loudly and typed.
 *
 * Retryable errors surface as retryable activity failures (Temporal retries
 * on a healthy worker); every other class is a definitive step outcome
 * returned to the orchestrator — retrying a policy denial or an ambiguous
 * question burns budget without changing the answer.
 */
export class CapabilityError extends Error {
  readonly errorClass: ErrorClass;
  readonly details: Record<string, unknown> | undefined;

  constructor(errorClass: ErrorClass, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CapabilityError';
    this.errorClass = errorClass;
    this.details = details;
  }

  /** The task-contract `capability_error` wire shape. */
  toProtocol(): CapabilityErrorBody {
    const body: CapabilityErrorBody = { class: this.errorClass, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}
