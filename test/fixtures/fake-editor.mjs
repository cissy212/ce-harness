#!/usr/bin/env node
// A minimal stand-in for the `code` (VS Code) CLI, used exclusively by
// tests so they never launch a real editor.
//
// Records its argv to a JSON file whose path is supplied via
// FAKE_EDITOR_OUTPUT, then exits with FAKE_EDITOR_EXIT_CODE (default 0)
// so tests can assert on failure handling.

import { writeFileSync } from "node:fs";

const outputFile = process.env.FAKE_EDITOR_OUTPUT;

if (outputFile) {
  writeFileSync(outputFile, JSON.stringify({ argv: process.argv.slice(2) }, null, 2), "utf8");
}

const exitCode = process.env.FAKE_EDITOR_EXIT_CODE
  ? parseInt(process.env.FAKE_EDITOR_EXIT_CODE, 10)
  : 0;
if (process.env.FAKE_EDITOR_STDERR) {
  process.stderr.write(process.env.FAKE_EDITOR_STDERR);
}
process.exit(exitCode);
