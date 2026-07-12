// R2 tool PAIR (item 3), the gate half — negation of both approved branches.
// Lifts to require-approval (refused at the gateway) unless the withdrawal is
// approved for change.withdraw OR is a compensation unwind of change.submit.
@id("gate-tool-itsm-change-withdraw")
@decision("require-approval")
permit (
  principal is Agent,
  action == Action::"tool:itsm:change_withdraw",
  resource == Service::"svc:itsm"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("itsm:change:withdraw") &&
  !(
    (context.approval.granted == true &&
     context.approval has capability &&
     context.approval.capability == "change.withdraw") ||
    (context.compensation.active == true &&
     context.compensation has original_capability &&
     context.compensation.original_capability == "change.submit")
  )
};
