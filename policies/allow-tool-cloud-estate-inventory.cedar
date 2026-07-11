// Agents holding the delegated cloud-inventory scope may call the
// cloud-estate inventory_search tool through the Tool Gateway PEP.
// Tool calls are modeled as tool:{server}:{tool}: the action names the
// exact tool, the resource names the server — an ungoverned tool has no
// action and therefore no permit. The tenant comparison is tautological
// today (context.tenant is the principal's own tenant); it is a shape-pin
// so per-tenant tool servers can tighten it without changing requests.
@id("allow-tool-cloud-estate-inventory")
permit (
  principal is Agent,
  action == Action::"tool:cloud-estate:inventory_search",
  resource == Service::"svc:cloud-estate"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("cloud:inventory:read")
};
