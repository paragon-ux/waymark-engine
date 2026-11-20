# Security

Waymark Engine is a local CLI and stdio MCP server with an optional, strictly loopback-only HTTP/SSE telemetry viewer (`waymark repl --live`, bound to `127.0.0.1` and disabled unless `WAYMARK_TELEMETRY=1` is set). It does not provide a remote network server, cloud sync, or remote execution service.

## Security Boundaries & Guarantees

- **Repository containment**: Paths are repository-relative and directory traversal and symlink escapes are rejected (`normalizeRelativePath`, `resolveRepositoryFile`) before filesystem probing.
- **Explicit argv execution (no shell)**: External tools (`@paragon-ux/codedb-core` and `@paragon-ux/capn-hook`) are invoked with explicit argv arrays (`shell: false`), hard timeouts, and output bounds. On Windows, `.cmd` and `.bat` shims are rejected (`CODEDB_UNSUPPORTED_SHIM`, `CAPN_UNSUPPORTED_SHIM`).
- **Operator-controlled executable paths**: MCP tool arguments never select host binaries or scripts; `WAYMARK_CAPN_EXECUTABLE` and `WAYMARK_CODEDB_EXECUTABLE` are honored only from operator-controlled server environment or CLI startup flags.
- **Private local IPC**: On POSIX hosts, daemon Unix domain sockets, PID records, and the daemon registry live inside a per-user `0700` runtime directory (verified via `lstat` for ownership and non-symlink status) with `0600` socket/file permissions and atomic writes.
- **Loopback live viewer hardening**: The optional REPL viewer binds exclusively to `127.0.0.1`, requires `WAYMARK_TELEMETRY=1`, enforces a per-session random access token (`timingSafeEqual`), validates strict `Host` and `Origin` headers, sets a nonce-based Content-Security-Policy with `frame-ancestors 'none'` and `X-Frame-Options: DENY`, and renders telemetry via `textContent`.
- **Bounded parsing**: Symbol discovery enforces a pre-read 1 MiB file size cap (`FILE_TOO_LARGE`), disables raw HTML parsing in `markdown-it` (`{ html: false }`), and fails closed at parser boundaries (`PARSE_ERROR`, `PARSER_UNAVAILABLE`).
- **Fail-closed discovery & tamper-evident spans**: The router never fabricates answers; unanswerable questions return `miss`. Span anchors are hash-pinned; `verifyHop` quarantines (`STALE`) anything it cannot prove.

## Reporting a Vulnerability

Please report security vulnerabilities privately via GitHub Security Advisories:

- **Private disclosure URL**: <https://github.com/paragon-ux/waymark-engine/security/advisories/new>

Do not open a public GitHub issue with exploit details. Include reproduction steps, affected version, and host OS/Node.js version.
