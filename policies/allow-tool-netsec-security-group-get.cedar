// Agents holding the delegated netsec secgroup-read scope may call the netsec
// security_group_get tool (R0) through the Tool Gateway PEP.
@id("allow-tool-netsec-security-group-get")
permit (
  principal is Agent,
  action == Action::"tool:netsec:security_group_get",
  resource == Service::"svc:netsec"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("netsec:secgroup:read")
};
