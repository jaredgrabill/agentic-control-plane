// Compensation delegations are permitted WITHOUT re-approval. When the
// orchestrator unwinds a saga (failure, cancellation, or kill-switch), it
// re-dispatches each declared compensator through the same governed
// delegation PEP with a `compensation` context flag. Re-gating the unwind on
// a human approval would leave a live R2 write dangling whenever a task fails
// unattended — so the ORIGINAL approval that authorized the write is what
// pre-authorizes its compensator (governance-and-policy.md): approving
// change.submit ⇄ change.withdraw is approving the pair. This is a PLAIN
// permit (no @decision): a compensation delegation is allowed outright, never
// lifted to require-approval. Defense-in-depth: the compensation flag can only
// originate in the TaskWorkflow unwind loop (agents never construct a
// StepDispatch), the broker-minted token carries a signed compensation claim,
// and item 3's tool-gateway risk-class PEP reads context.compensation the same
// way. Scoped to R1/R2 — an R3 compensator is never a safe unwind target.
@id("permit-compensation")
permit (
  principal is User,
  action == Action::"delegate",
  resource is Agent
)
when {
  context has compensation &&
  context.compensation.active == true &&
  principal.tenant == resource.tenant &&
  (context.risk == "R1" || context.risk == "R2")
};
