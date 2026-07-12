// R2 tool PAIR (item 3), the approved half. change_withdraw is permitted when
// EITHER the token carries a step-bound approval for change.withdraw (a
// human-approved direct withdrawal) OR it is a compensation dispatch unwinding
// a change.submit (the saga's declared inverse — pre-authorized by the
// original write's approval, never re-gated; see permit-compensation.cedar).
// `has`-guards keep the gate half from erroring on the absent branch fields.
@id("permit-tool-itsm-change-withdraw")
permit (
  principal is Agent,
  action == Action::"tool:itsm:change_withdraw",
  resource == Service::"svc:itsm"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("itsm:change:withdraw") &&
  (
    (context.approval.granted == true &&
     context.approval has capability &&
     context.approval.capability == "change.withdraw") ||
    (context.compensation.active == true &&
     context.compensation has original_capability &&
     context.compensation.original_capability == "change.submit")
  )
};
