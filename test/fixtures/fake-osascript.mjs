#!/usr/bin/env node
// A minimal stand-in for `osascript`, used exclusively by tests so they
// never invoke real AppleScript or launch a real iTerm2 window.
//
// Records its argv (which includes the full AppleScript source passed
// via `-e`) to a JSON file whose path is supplied via FAKE_OSASCRIPT_OUTPUT.
//
// isITerm2Available()'s cheap probe script ("id of application ...") and
// the real two-pane-open script (always contains "write text") are
// controlled by two independent exit-code knobs, so tests can simulate
// "iTerm2 not installed" and "iTerm2 installed, but opening the layout
// fails" separately:
//   FAKE_OSASCRIPT_PROBE_EXIT_CODE  -- the availability probe (default 0)
//   FAKE_OSASCRIPT_EXIT_CODE        -- the two-pane-open script (default 0)

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outputFile = process.env.FAKE_OSASCRIPT_OUTPUT;

if (outputFile) {
  writeFileSync(outputFile, JSON.stringify({ argv: args }, null, 2), "utf8");
}

const script = args[1] ?? "";
const isAvailabilityProbe = !script.includes("write text");

if (process.env.FAKE_OSASCRIPT_STDERR) {
  process.stderr.write(process.env.FAKE_OSASCRIPT_STDERR);
}

if (isAvailabilityProbe) {
  const probeExitCode = process.env.FAKE_OSASCRIPT_PROBE_EXIT_CODE
    ? parseInt(process.env.FAKE_OSASCRIPT_PROBE_EXIT_CODE, 10)
    : 0;
  process.exit(probeExitCode);
}

const exitCode = process.env.FAKE_OSASCRIPT_EXIT_CODE
  ? parseInt(process.env.FAKE_OSASCRIPT_EXIT_CODE, 10)
  : 0;
process.exit(exitCode);
