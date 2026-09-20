#!/usr/bin/env node
// waymark-list: list the Capn chart store (lexical-only fork).
import { runCli } from "../dist/src/cli.js";
await runCli("list", process.argv.slice(2));
