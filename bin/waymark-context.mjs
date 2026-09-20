#!/usr/bin/env node
// waymark-context: context the Capn chart store (lexical-only fork).
import { runCli } from "../dist/src/cli.js";
await runCli("context", process.argv.slice(2));
