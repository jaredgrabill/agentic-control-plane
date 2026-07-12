// Tenant principals may have R1 (draft-risk) capabilities executed on their
// behalf by agents in their own tenant — no human gate (R1 is not a write to
// production state; change.draft creates a DRAFT, submitted separately at R2).
// Without this permit change.draft (R1) is undeliverable — the delegation PEP
// default-denies it. R2 stays gated (gate-r2-delegation); R3 default-deny.
@id("allow-r1-delegation")
permit (
  principal is User,
  action == Action::"delegate",
  resource is Agent
)
when {
  context.risk == "R1" &&
  principal.tenant == resource.tenant &&
  context.scopes.contains("task:submit")
};
