#!/usr/bin/env node
// waymark-init: initialize the lexical Capn store (deterministic BM25, bundled fork).
import { runCli } from "../dist/src/cli.js";
await runCli("init", process.argv.slice(2));
