// R2 tool PAIR (item 3), the gate half — negation of the approved/compensation
// branches. Lifts to require-approval (refused at the gateway) otherwise.
@id("gate-tool-cloud-estate-tag-remove")
@decision("require-approval")
permit (
  principal is Agent,
  action == Action::"tool:cloud-estate:tag_remove",
  resource == Service::"svc:cloud-estate"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("cloud:tag:write") &&
  !(
    (context.approval.granted == true &&
     context.approval has capability &&
     context.approval.capability == "cloud.tag_restore") ||
    (context.compensation.active == true &&
     context.compensation has original_capability &&
     context.compensation.original_capability == "cloud.tag_apply")
  )
};
