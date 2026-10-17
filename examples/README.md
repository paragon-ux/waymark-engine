# Examples

Each example is a real run of one Waymark MCP prompt against this repository, made from Claude Code. Every tool call and output shown is what the tools returned.

| Prompt | Invocation | What it produced |
| :--- | :--- | :--- |
| [`architectural-map`](architectural-map.md) | `/waymark-engine:architectural-map capnStoreArgs` | Call chain for every capn invocation; charted as the `boundaries` facet |
| [`explore-subsystem`](explore-subsystem.md) | `/waymark-engine:explore-subsystem getResidentClient` | Resident codedb client lifecycle; charted as the `lifecycle` facet |
| [`bootstrap-semantic-map`](bootstrap-semantic-map.md) | `/waymark-engine:bootstrap-semantic-map` | The other three facets, verified and charted; a 5/5 map |

The examples ran in table order and build on each other. Bootstrap starts at 2/5 because the first two examples had already charted two facets.

## Capture details

- Recorded on 2026-10-17 at commit `6ae7f39`, using the local `dist/` build of 4.0.0 on Windows.
- Every tool call also passed `"root"` set to the repository path. It is left out of the examples.
- Line numbers and call graphs reflect that commit and drift as the code changes.

## Run them yourself

1. Build and register the server, from the repository root:

    ```bash
    npm ci && npm run build
    ```

    ```bash
    claude mcp add waymark-engine --scope user -e CODEDB_ALLOW_TEMP=1 -- node "$PWD/dist/src/mcp/capnIndex.js"
    ```

2. Open Claude Code in this repository and run one of the invocations above.

Charts go to `.waymark/memory`, which `.waymark/.gitignore` keeps out of Git. To list or remove them:

```bash
waymark list
```

```bash
waymark unchart <id>
```

## Findings

Running the prompts turned up these gaps:

| Area | Finding |
| :--- | :--- |
| `explore-subsystem` prompt | Declares a `root` argument but leaves it out of the prompt text. A root given by the user never reaches the agent. |
| `architectural-map` prompt | Has no `root` argument. When the host's working directory isn't the repository, the agent has to find the root on its own. |
| Tier 1 call graph | Misses callers inside anonymous functions. The MCP tool handlers that call `publish` don't appear (see [architectural-map](architectural-map.md#3-verify-against-the-source)). |
| Tier 1 call graph | Misses a call made from a class method: `WaymarkDaemon.start` → `getResidentClient` (see [explore-subsystem](explore-subsystem.md#4-verify-against-the-source)). |
| Bootstrap drafts | Each draft's evidence is the first lines of a file, usually imports, so drafts point to files but don't support any claim (see [bootstrap-semantic-map](bootstrap-semantic-map.md#1-status-and-drafts)). |

The verify steps caught the call-graph and draft gaps. That's why each prompt has the agent check results against the source before charting.
