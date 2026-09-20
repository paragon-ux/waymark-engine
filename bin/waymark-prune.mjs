#!/usr/bin/env node
// waymark-prune: prune the Capn chart store (lexical-only fork).
import { runCli } from "../dist/src/cli.js";
await runCli("prune", process.argv.slice(2));
