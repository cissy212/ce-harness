#!/usr/bin/env node
// A minimal stand-in for the `claude` executable, used exclusively by
// tests so they never launch the real Claude Code CLI.
//
// Records its cwd, argv, and the CE_* environment variables it was
// launched with to a JSON file whose path is supplied via
// FAKE_CLAUDE_OUTPUT, then exits with FAKE_CLAUDE_EXIT_CODE (default 0)
// so tests can assert on ce's exit-code propagation.

import { writeFileSync } from "node:fs";

const outputFile = process.env.FAKE_CLAUDE_OUTPUT;

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
          CE_LENSES_DIR: process.env.CE_LENSES_DIR ?? null,
          CE_DIFF_BASE: process.env.CE_DIFF_BASE ?? null,
          CE_DIFF_HEAD: process.env.CE_DIFF_HEAD ?? null,
          CE_CODE_NAV_AVAILABLE: process.env.CE_CODE_NAV_AVAILABLE ?? null,
          CE_CODE_NAV_PROVIDER: process.env.CE_CODE_NAV_PROVIDER ?? null,
          OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ?? null,
          OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ?? null,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

const exitCode = process.env.FAKE_CLAUDE_EXIT_CODE
  ? parseInt(process.env.FAKE_CLAUDE_EXIT_CODE, 10)
  : 0;
process.exit(exitCode);
