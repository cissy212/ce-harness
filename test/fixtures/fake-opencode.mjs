#!/usr/bin/env node
// A minimal stand-in for the `opencode` executable, used exclusively by
// tests so they never launch the real OpenCode.
//
// Records its cwd, argv, and the CE_* environment variables it was
// launched with to a JSON file whose path is supplied via
// FAKE_OPENCODE_OUTPUT, then exits with FAKE_OPENCODE_EXIT_CODE (default
// 0) so tests can assert on ce's exit-code propagation.

import { writeFileSync } from "node:fs";

const outputFile = process.env.FAKE_OPENCODE_OUTPUT;

if (outputFile) {
  writeFileSync(
    outputFile,
    JSON.stringify(
      {
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        env: {
          CE_WORKSPACE: process.env.CE_WORKSPACE ?? null,
          CE_WORKTREE: process.env.CE_WORKTREE ?? null,
          CE_PROJECT: process.env.CE_PROJECT ?? null,
          CE_ISSUE: process.env.CE_ISSUE ?? null,
          CE_OPENSPEC_STORE: process.env.CE_OPENSPEC_STORE ?? null,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

const exitCode = process.env.FAKE_OPENCODE_EXIT_CODE
  ? parseInt(process.env.FAKE_OPENCODE_EXIT_CODE, 10)
  : 0;
process.exit(exitCode);
