#!/usr/bin/env node
// waymark-ask: one-shot two-phase question router (AST first, Capn fallback).
import { runCli } from "../dist/src/cli.js";
await runCli("ask", process.argv.slice(2));
