// Agents holding the delegated cloud-cost scope may call the cloud-estate
// cost_report tool through the Tool Gateway PEP. See
// allow-tool-cloud-estate-inventory for the tool:{server}:{tool} model
// and the tenant shape-pin.
@id("allow-tool-cloud-estate-cost")
permit (
  principal is Agent,
  action == Action::"tool:cloud-estate:cost_report",
  resource == Service::"svc:cloud-estate"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("cloud:cost:read")
};
