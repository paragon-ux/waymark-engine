#!/usr/bin/env node
// waymark-map: inspect, heal, or export the repository Semantic Repo Map.
import { runCli } from "../dist/src/cli.js";
await runCli("map", process.argv.slice(2));
