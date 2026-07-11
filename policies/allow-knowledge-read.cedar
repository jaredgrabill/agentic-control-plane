// Agents holding the delegated knowledge-read scope may retrieve from
// their own tenant's corpus. The scope arrives via RFC 8693 exchange —
// an agent acting for a principal without it is denied here, in the
// query path, not in the prompt.
@id("allow-knowledge-read")
permit (
  principal is Agent,
  action in [Action::"knowledge.search", Action::"knowledge.answer_with_citations"],
  resource is Corpus
)
when {
  principal.tenant == resource.tenant &&
  context.scopes.contains("knowledge:search:read")
};
