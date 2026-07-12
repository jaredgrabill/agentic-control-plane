// Agents holding the delegated itsm change-draft scope may call the itsm
// change_create_draft tool (R1) through the Tool Gateway PEP. R1 tools are not
// human-gated — a draft is not a production write; submitting it is (R2).
@id("allow-tool-itsm-change-draft")
permit (
  principal is Agent,
  action == Action::"tool:itsm:change_create_draft",
  resource == Service::"svc:itsm"
)
when {
  principal.tenant == context.tenant &&
  context.scopes.contains("itsm:change:draft")
};
