// Anyone — users straight from an IDE-shaped MCP client as well as agents
// on a delegated token — may call the knowledge_search tool through the
// Tool Gateway PEP when their token carries the knowledge-read scope. The
// principal is deliberately untyped: retrieval is the one governed tool
// that both humans and agents reach through the same door. `principal has
// tenant` guards the untyped attribute access; the knowledge service's own
// inner PEP (knowledge.search on the Corpus) still runs behind this.
@id("allow-tool-knowledge-search")
permit (
  principal,
  action == Action::"tool:knowledge:knowledge_search",
  resource == Service::"svc:knowledge"
)
when {
  principal has tenant &&
  principal.tenant == context.tenant &&
  context.scopes.contains("knowledge:search:read")
};
