#!/usr/bin/env node
// waymark-discover: one-shot symbolic symbol discovery for one repository-relative file.
import { runCli } from "../dist/src/cli.js";
await runCli("discover-symbols", process.argv.slice(2));
