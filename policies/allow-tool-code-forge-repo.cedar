// Agents holding the delegated repo-read scope may call the code-forge
// repo_dependencies tool through the Tool Gateway PEP. See
// allow-tool-cloud-estate-inventory for the tool:{server}:{tool} model
// and the tenant shape-pin.
@id("allow-tool-code-forge-repo")
permit (
  principal is Agent,
  action == Action::"tool:code-forge:repo_dependencies",
  resource == Service::"svc:code-forge"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("code:repo:read")
};
