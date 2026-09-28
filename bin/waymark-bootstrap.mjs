#!/usr/bin/env node
// waymark-bootstrap: two-pass bootstrap of 5-facet Semantic Repo Map into SQLite consensus ledger.
import { runCli } from "../dist/src/cli.js";
await runCli("bootstrap", process.argv.slice(2));
