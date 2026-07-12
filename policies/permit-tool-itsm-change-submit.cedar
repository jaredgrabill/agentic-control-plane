// R2 tool PAIR (item 3), the approved half. The itsm change_submit tool is a
// production write, permitted ONLY when the presented token carries a
// step-bound approval claim for change.submit (the tool gateway derives
// context.approval from the VERIFIED token and binds it to this exact step
// before the decision). The `has capability` guard keeps the gate half from
// evaluation-erroring on an ungranted approval (which has no capability field).
@id("permit-tool-itsm-change-submit")
permit (
  principal is Agent,
  action == Action::"tool:itsm:change_submit",
  resource == Service::"svc:itsm"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("itsm:change:submit") &&
  context.approval.granted == true &&
  context.approval has capability &&
  context.approval.capability == "change.submit"
};
