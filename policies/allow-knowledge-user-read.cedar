// Tenant users holding the knowledge-read scope may retrieve from their
// own tenant's corpus — the inner knowledge PEP for IDE-shaped access
// through the tool gateway. Until Item 5 only agents could search
// (allow-knowledge-read); without this permit the gateway would allow the
// knowledge_search tool call and the knowledge service would then deny
// the same user, a contradiction between the two PEPs of one door.
@id("allow-knowledge-user-read")
permit (
  principal is User,
  action == Action::"knowledge.search",
  resource is Corpus
)
when {
  principal.tenant == resource.tenant &&
  context.scopes.contains("knowledge:search:read")
};
