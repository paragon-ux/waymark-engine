#!/usr/bin/env node
// waymark-unchart: unchart the Capn chart store (lexical-only fork).
import { runCli } from "../dist/src/cli.js";
await runCli("unchart", process.argv.slice(2));
