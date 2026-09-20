#!/usr/bin/env node
// waymark-chart: chart a question + answer (+ optional files) into Capn memory.
import { runCli } from "../dist/src/cli.js";
await runCli("chart", process.argv.slice(2));
