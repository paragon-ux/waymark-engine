# Memory Store & State Layout

Waymark keeps everything it writes inside a repository under `.waymark/`. It never reads or writes `.capn/`, which belongs to upstream capn.

## Layout

| Path | Contents | Written by |
| :--- | :--- | :--- |
| `.waymark/.gitignore` | `*`, so the folder never shows up in `git status`. An existing file is kept. | The first Waymark write in the repository |
| `.waymark/memory/` | Tier 4 memory store: `config.json` (`{"embedding": false}`), `entries/*.md`, `map.json`, `qmd/index.sqlite` | `waymark init`, chart, bust, prune, unchart |
| `.waymark/paths.v3.cache` | Tier 2 repository path cache | Path router (skipped when `WAYMARK_READ_ONLY=1`) |
| `.waymark/sessions/active.jsonl` | Opt-in telemetry | Session logger (`WAYMARK_TELEMETRY=1`) |

On POSIX hosts, the daemon Unix socket, PID record, and daemon registry live in a per-user `0700` runtime directory (`$XDG_RUNTIME_DIR/waymark` or `os.tmpdir()/waymark-<uid>`, falling back to `/tmp/waymark-<uid>` if the candidate would exceed the POSIX Unix domain socket `sun_path` length limit) with `0600` socket/file permissions and atomic writes (Windows uses Named Pipes and `os.tmpdir()/waymark`). The PID record is informational only: `waymark daemon stop` never uses it to choose a process to kill (audit finding F-01).

In code, `memoryStoreDir(root)` (`src/stateDir.ts`) is the only definition of the store location. Every store read and every capn invocation goes through it.

## Why not `.capn/`

`.capn/` is upstream capn's folder. `@paragon-ux/capn-hook`, the lexical-only fork that powers Tier 4, is a different implementation that still used the same folder name. Waymark 3.1 and earlier also put its memory store, path cache, and PID file there. In a repository where upstream capn was also in use, each tool read and wrote the other's data: the fork's prune could delete upstream entries it judged stale, and `waymark init` rewrote upstream's `config.json`.

Path discovery still skips `.capn/` so upstream stores never appear as repository files.

## The capn store-dir contract

Waymark passes the project root and the store explicitly on every capn invocation:

```text
capn --root <absolute repository root> --store-dir <absolute .waymark/memory path> <command> [args...]
```

The bundled `@paragon-ux/capn-hook` implements this contract from 2.0.0 on:

- `--root` is the project root as given: no walking up for a store, no `git rev-parse`.
- `--store-dir` holds the whole store: `entries/`, `map.json`, `config.json`, and the lexical index. A relative path resolves against the root.
- With `--store-dir`, capn leaves `<root>/.gitignore` alone; Waymark writes `.waymark/.gitignore` itself.
- capn never reads, moves, or deletes a `.capn/` folder. Its own default store, when run directly, is `.capn-hook/`.

The flags come before the subcommand on purpose. A capn without them, such as capn-hook 1.x set through `WAYMARK_CAPN_EXECUTABLE`, treats `--root` as an unknown command, prints usage, and exits 1 before it touches disk. Waymark maps that response to `CAPN_STORE_DIR_UNSUPPORTED` (exit code 2), and Tier 4 stays off for that executable:

- `waymark init` and `waymark memory init` fail with that code.
- `chart` reports the error and publishes nothing.
- `ask` surfaces `CAPN_STORE_DIR_UNSUPPORTED` as an explicit error (exit code 2) rather than hiding it as a silent miss.

Tiers 1–3 are unaffected.

To try a local fork checkout, point Waymark at its entry file: `WAYMARK_CAPN_EXECUTABLE=/path/to/capn-hook/dist/capn.js`. Waymark runs `.js`, `.mjs`, and `.cjs` entries with the current Node.
