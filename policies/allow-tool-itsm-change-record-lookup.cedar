// Agents holding the delegated itsm change-read scope may call the itsm
// change_record_lookup tool (R0) through the Tool Gateway PEP — a read that
// finds change records by service and/or deploy_id. Same scope as change_get;
// see allow-tool-cloud-estate-inventory for the tool:{server}:{tool} model.
@id("allow-tool-itsm-change-record-lookup")
permit (
  principal is Agent,
  action == Action::"tool:itsm:change_record_lookup",
  resource == Service::"svc:itsm"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("itsm:change:read")
};
