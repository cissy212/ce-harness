#!/usr/bin/env node
// A minimal stand-in for the `codegraph` executable, used exclusively by
// tests so they never depend on the real CodeGraph binary being
// installed. Supports exactly what ce-harness itself shells out to:
// `--version` (availability probe) and `init <path>` (index creation).
//
// Configurable via environment variables so tests can exercise every
// branch of ce-harness's CodeGraph provisioning logic:
//   FAKE_CODEGRAPH_INIT_EXIT_CODE  - exit code for `init` (default: 0)
//   FAKE_CODEGRAPH_INIT_STDERR     - stderr text for a failing `init`
//   FAKE_CODEGRAPH_SKIP_CREATE     - "1" to report success without
//                                    actually creating .codegraph/,
//                                    simulating a tool that lies about
//                                    its own outcome

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , command, ...rest] = process.argv;

if (command === "--version") {
  console.log("codegraph 0.0.0-fake");
  process.exit(0);
}

if (command === "init") {
  const targetPath = rest[0];
  const exitCode = process.env.FAKE_CODEGRAPH_INIT_EXIT_CODE
    ? parseInt(process.env.FAKE_CODEGRAPH_INIT_EXIT_CODE, 10)
    : 0;

  if (exitCode !== 0) {
    process.stderr.write(process.env.FAKE_CODEGRAPH_INIT_STDERR ?? "fake codegraph init failure\n");
    process.exit(exitCode);
  }

  if (process.env.FAKE_CODEGRAPH_SKIP_CREATE !== "1" && targetPath) {
    const indexDir = join(targetPath, ".codegraph");
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, "codegraph.db"), "fake index data", "utf8");
  }

  console.log(`Initialized CodeGraph index at ${targetPath}`);
  process.exit(0);
}

console.error(`fake-codegraph.mjs: unsupported command "${command}"`);
process.exit(1);
