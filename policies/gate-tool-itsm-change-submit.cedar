// R2 tool PAIR (item 3), the gate half. Matches every change_submit call whose
// token does NOT carry a change.submit approval bound to this step, and the
// @decision annotation lifts that allow to require-approval — which the tool
// gateway (a verify-only PEP) refuses. The restrictive lift makes the pair
// fail-safe: a sloppy gate can only over-gate (block), never bypass. The
// approved case is excluded here, so permit and gate are mutually exclusive.
@id("gate-tool-itsm-change-submit")
@decision("require-approval")
permit (
  principal is Agent,
  action == Action::"tool:itsm:change_submit",
  resource == Service::"svc:itsm"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("itsm:change:submit") &&
  !(context.approval.granted == true &&
    context.approval has capability &&
    context.approval.capability == "change.submit")
};
