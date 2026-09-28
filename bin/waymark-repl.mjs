#!/usr/bin/env node
// waymark-repl: interactive diagnostic shell and scripted session driver.
import { runCli } from "../dist/src/cli.js";
await runCli("repl", process.argv.slice(2));
