// Tenant principals may have R0 (read-only) capabilities executed on their
// behalf by agents in their own tenant. R1+ delegations have no permit in
// v0 — default deny keeps writes impossible until the approval machinery
// exists to make them safe (roadmap Phase 3).
@id("allow-r0-delegation")
permit (
  principal is User,
  action == Action::"delegate",
  resource is Agent
)
when {
  context.risk == "R0" &&
  principal.tenant == resource.tenant &&
  context.scopes.contains("task:submit")
};
