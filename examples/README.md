# Examples

Each example is a run of one Waymark MCP prompt against this repository. They were first made from Claude Code. [`record.mjs`](record.mjs) re-records them by making the same prompt and tool calls the agent made. Every output shown is what the tools returned.

| Prompt | Invocation | What it produced |
| :--- | :--- | :--- |
| [`architectural-map`](architectural-map.md) | `/waymark-engine:architectural-map capnStoreArgs` | Call chain for every capn invocation; charted as the `boundaries` facet |
| [`explore-subsystem`](explore-subsystem.md) | `/waymark-engine:explore-subsystem getResidentClient` | Resident codedb client lifecycle; charted as the `lifecycle` facet |
| [`bootstrap-semantic-map`](bootstrap-semantic-map.md) | `/waymark-engine:bootstrap-semantic-map` | The other three facets, verified and charted; a 5/5 map |

The examples ran in table order and build on each other. Bootstrap starts at 2/5 because the first two examples had already charted two facets.

## Capture details

- Recorded on 2026-10-17 with the review fixes on top of commit `f859003`, with codedb-core 2.1.1, on Windows.
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

To re-record all three, use a checkout with no charts yet, such as a fresh `git worktree add`, because the examples build on an empty store:

```bash
node examples/record.mjs <checkout> > recording.json
```

Charts go to `.waymark/memory`, which `.waymark/.gitignore` keeps out of Git. To list or remove them:

```bash
waymark list
```

```bash
waymark unchart <id>
```

## Findings

Running the prompts turned up these gaps:

| Area | Finding | Status |
| :--- | :--- | :--- |
| `explore-subsystem` prompt | Declared a `root` argument but left it out of the prompt text, so a root given by the user never reached the agent. | Fixed in `16449e4`: every prompt with `root` set tells the agent to pass it on each tool call. |
| `architectural-map` prompt | Had no `root` argument, so when the host's working directory wasn't the repository, the agent had to find the root on its own. | Fixed in `16449e4`: all three prompts take an optional `root`. |
| Tier 1 call graph | Missed callers inside anonymous functions, such as the MCP tool handlers that call `publish`. | Fixed in codedb-core 2.1.0: class methods, object-literal functions and arrow consts are call-graph nodes, named like `waymarkMemoryTool.handler`. |
| Tier 1 call graph | Missed a call made from a class method: `WaymarkDaemon.start` → `getResidentClient`. | Fixed in codedb-core 2.1.0. |
| Tier 1 lookup | In codedb-core 2.1.0, a name was ambiguous when test files had mock methods with the same name, so the `queryCapnMemory` hop in [architectural-map](architectural-map.md#1-callers) stopped. | Fixed in codedb-core 2.1.1: a name resolves to its one definition outside test files. |
| Bootstrap drafts | Each draft's evidence was the first lines of a file, usually imports, so drafts pointed to files but didn't support any claim. | Fixed in `16449e4`: evidence is now the lines that name the facet's keywords, and never imports or comments. |
| Prompts | `explore-subsystem` and `architectural-map` filled a missing argument with `"unknown"`, pointed agents at the hidden `waymark_chart` tool, and never showed `plain`, `outline` or the facet ids. `bootstrap-semantic-map` never said to call `bootstrap`. | Fixed with the review fixes: a missing argument is JSON-RPC `-32602`, and each prompt spells out the canonical `waymark_ask` / `waymark_memory` calls. |
| Bootstrap drafts | Candidate files were Waymark's own `src/*.ts` names, so other repositories got `package.json` drafts. | Fixed with the review fixes: candidates come from the repository's manifest entries and source files. |
| Bootstrap drafts | The first re-recording cited `semanticMap.ts`'s own keyword table and patterns as evidence, and missed `stateDir.ts` because path hints didn't split camelCase. | Fixed with the review fixes: keywords inside string, template and regex literals don't count, and path hints match camelCase words. |
| Tier 1 call graph | codedb-core 2.1.1 reads a `"` or `'` inside a regex literal as the start of a string, so the enclosing function runs to the end of the file. `isNotApplicableAnswer` showed up as a caller of `publish`. | Worked around in Waymark by writing those quotes as `\x22`/`\x27`. Still open in codedb-core. |

Every gap except the prompt `root` handling was caught by a verify step or by re-recording. That's why each prompt has the agent check results against the source before charting.

A call through an object whose type codedb can't see, such as a local `session.send(...)`, can still resolve to the repository's one method of that name. Check method callers against the source before charting them.
