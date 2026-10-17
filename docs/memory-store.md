# Memory Store & State Layout

Waymark keeps everything it writes inside a repository under `.waymark/`. It never reads or writes `.capn/`, which belongs to upstream capn.

## Layout

| Path | Contents | Written by |
| :--- | :--- | :--- |
| `.waymark/.gitignore` | `*`, so the folder never shows up in `git status`. An existing file is kept. | The first Waymark write in the repository |
| `.waymark/memory/` | Tier 4 memory store: `config.json` (`{"embedding": false}`), `entries/*.md`, `map.json`, `qmd/index.sqlite` | `waymark init`, chart, bust, prune, unchart, migrate |
| `.waymark/paths.v2.cache` | Tier 2 repository path cache | Path router (skipped when `WAYMARK_READ_ONLY=1`) |
| `.waymark/sessions/active.jsonl` | Opt-in telemetry | Session logger (`WAYMARK_TELEMETRY=1`) |

The daemon socket, PID record, and daemon registry live in the OS temp directory. The PID record is informational only: `waymark daemon stop --force` never uses it to choose a process to kill (audit finding F-01).

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
- `ask` misses Tier 4 with `STORE_UNINITIALIZED`.

Tiers 1–3 are unaffected.

To try a local fork checkout, point Waymark at its entry file: `WAYMARK_CAPN_EXECUTABLE=/path/to/capn-hook/dist/capn.js`. Waymark runs `.js`, `.mjs`, and `.cjs` entries with the current Node.

## Migrating a store from Waymark 3.x

Earlier `waymark init` runs created the store in `.capn/`. Waymark no longer reads it. To keep those charts:

```bash
waymark memory migrate            # source defaults to .capn
waymark memory migrate --from <dir>
```

Migration is explicit and copy-only. The source is read and never moved, modified, or deleted. It fails closed, and copies nothing, when:

| Code | Condition |
| :--- | :--- |
| `MIGRATE_SOURCE_NOT_LEXICAL` | The source has no readable `config.json`, or it is not `{"embedding": false}`. Waymark only ever created lexical stores. |
| `MIGRATE_SOURCE_INVALID` | A file in `entries/` named like an entry is not a `capn: 1` entry, or the source is the Waymark store itself. |
| `MIGRATE_DESTINATION_NOT_EMPTY` | `.waymark/memory` already holds entries. Migration never merges stores. |
| `CAPN_STORE_DIR_UNSUPPORTED` | The capn executable lacks the store-dir flags, so the new store cannot be indexed. |

On success, Waymark initializes `.waymark/memory`, copies the entries, and re-runs init to rebuild the lexical index and file map. Entries whose backing files have changed are pruned on the next recall, as usual.

An upstream capn store initialized with `--no-embedding` looks the same as one Waymark created. If you point migrate at one, its entries are copied into Waymark's store, and the source is still left untouched.
