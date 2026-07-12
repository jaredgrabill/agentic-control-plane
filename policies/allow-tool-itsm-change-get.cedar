// Agents holding the delegated itsm change-read scope may call the itsm
// change_get tool (R0) through the Tool Gateway PEP. See
// allow-tool-cloud-estate-inventory for the tool:{server}:{tool} model.
@id("allow-tool-itsm-change-get")
permit (
  principal is Agent,
  action == Action::"tool:itsm:change_get",
  resource == Service::"svc:itsm"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("itsm:change:read")
};
