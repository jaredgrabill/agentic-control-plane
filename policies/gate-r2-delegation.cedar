// R2 (write) delegations are permitted ONLY through a human approval gate.
// Cedar stays two-verdict; the @decision annotation lifts the allow this
// permit determines into a three-way require-approval (see apps/policy/src/
// pdp.ts) — the orchestrator suspends the step on an ApprovalWorkflow until a
// verified approver decides, and reports a denied/timed-out step as not
// executed. R3 stays default-deny (no permit); R1 delegation permits arrive
// with the change agent (item 3). The restrictive lift makes this fail-safe:
// a sloppy pair policy can only over-gate (block), never bypass. Compensation
// unwinds are excluded structurally (`!(context has compensation)`): a
// compensator is pre-authorized by the write's original approval and must
// never re-suspend on a human gate (permit-compensation.cedar).
@id("gate-r2-delegation")
@decision("require-approval")
permit (
  principal is User,
  action == Action::"delegate",
  resource is Agent
)
when {
  context.risk == "R2" &&
  principal.tenant == resource.tenant &&
  context.scopes.contains("task:submit") &&
  !(context has compensation)
};
