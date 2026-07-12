// Agents holding the delegated itsm calendar-read scope may call the itsm
// calendar_conflicts tool (R0) through the Tool Gateway PEP.
@id("allow-tool-itsm-calendar-conflicts")
permit (
  principal is Agent,
  action == Action::"tool:itsm:calendar_conflicts",
  resource == Service::"svc:itsm"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("itsm:calendar:read")
};
