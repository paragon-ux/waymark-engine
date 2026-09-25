#!/usr/bin/env node
// waymark-daemon: manage resident codedb background service
import { runCli } from "../dist/src/cli.js";
await runCli("daemon", process.argv.slice(2));
