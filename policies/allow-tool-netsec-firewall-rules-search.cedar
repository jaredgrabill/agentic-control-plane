// Agents holding the delegated netsec firewall-read scope may call the netsec
// firewall_rules_search tool (R0) through the Tool Gateway PEP. All four
// netsec tools are reads; no netsec write action is modeled — netsec.rule_apply
// (R2) is design-only pending its dual-control gate.
@id("allow-tool-netsec-firewall-rules-search")
permit (
  principal is Agent,
  action == Action::"tool:netsec:firewall_rules_search",
  resource == Service::"svc:netsec"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("netsec:firewall:read")
};
