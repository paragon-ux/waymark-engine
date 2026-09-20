# Security

Waymark Engine is a local CLI / stdio MCP server. It does not provide a network
server, cloud sync, or remote execution service.

- Paths are repository-relative and traversal is rejected (`normalizeRelativePath`).
- External tools (Capn) are invoked with explicit argv arrays, never a shell, with
  hard timeouts and output bounds; values are screened before being passed.
- Symbol discovery is bounded (file size cap, structured grammars only) and fails
  closed at parser boundaries (`PARSE_ERROR`, `PARSER_UNAVAILABLE`).
- The router never fabricates an answer: unanswerable questions return `miss`.
- Span anchors are hash-pinned; `verifyHop` quarantines (`STALE`) anything it
  cannot prove rather than trusting stale state.

## Reporting

Please report vulnerabilities privately to the repository owner rather than opening
a public issue with exploit details.
