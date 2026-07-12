// R2 tool PAIR (item 3), the approved half. tag_remove is a restore instrument
// in v0: it is permitted ONLY when the token carries a step-bound approval for
// cloud.tag_restore (the restore capability removes tags that were absent
// before) OR is a compensation dispatch unwinding a cloud.tag_apply. There is
// no standalone "remove a tag" capability yet — removal only ever undoes an add.
@id("permit-tool-cloud-estate-tag-remove")
permit (
  principal is Agent,
  action == Action::"tool:cloud-estate:tag_remove",
  resource == Service::"svc:cloud-estate"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("cloud:tag:write") &&
  (
    (context.approval.granted == true &&
     context.approval has capability &&
     context.approval.capability == "cloud.tag_restore") ||
    (context.compensation.active == true &&
     context.compensation has original_capability &&
     context.compensation.original_capability == "cloud.tag_apply")
  )
};
