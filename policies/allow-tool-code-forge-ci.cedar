// Agents holding the delegated CI-read scope may call the code-forge
// ci_runs tool through the Tool Gateway PEP. See
// allow-tool-cloud-estate-inventory for the tool:{server}:{tool} model
// and the tenant shape-pin.
@id("allow-tool-code-forge-ci")
permit (
  principal is Agent,
  action == Action::"tool:code-forge:ci_runs",
  resource == Service::"svc:code-forge"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("code:ci:read")
};
