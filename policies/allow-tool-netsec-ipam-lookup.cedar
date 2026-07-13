// Agents holding the delegated netsec ipam-read scope may call the netsec
// ipam_lookup tool (R0) through the Tool Gateway PEP.
@id("allow-tool-netsec-ipam-lookup")
permit (
  principal is Agent,
  action == Action::"tool:netsec:ipam_lookup",
  resource == Service::"svc:netsec"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("netsec:ipam:read")
};
