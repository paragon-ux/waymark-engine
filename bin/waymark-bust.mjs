#!/usr/bin/env node
// waymark-bust: bust the Capn chart store (lexical-only fork).
import { runCli } from "../dist/src/cli.js";
await runCli("bust", process.argv.slice(2));
