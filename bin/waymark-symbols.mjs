#!/usr/bin/env node
// waymark-symbols: batch symbol definitions and spans across the repository.
import { runCli } from "../dist/src/cli.js";
await runCli("symbols", process.argv.slice(2));
