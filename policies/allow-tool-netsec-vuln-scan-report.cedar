// Agents holding the delegated netsec vuln-read scope may call the netsec
// vuln_scan_report tool (R0) through the Tool Gateway PEP.
@id("allow-tool-netsec-vuln-scan-report")
permit (
  principal is Agent,
  action == Action::"tool:netsec:vuln_scan_report",
  resource == Service::"svc:netsec"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("netsec:vuln:read")
};
