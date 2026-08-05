#!/usr/bin/env node
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_SHEBANG = "#!/usr/bin/env node";

/**
 * TypeScript's emitted JS does not preserve or set the executable bit, so
 * a fresh `tsc` build leaves dist/cli.js as `-rw-r--r--` even though its
 * shebang line is correct. `npm link` (and any global install) then fails
 * with "permission denied" on POSIX systems, because the bin symlink
 * points at a file the shell isn't allowed to execute.
 *
 * This restores the executable bit after every build. `chmodSync` is a
 * safe no-op on Windows (there is no POSIX executable bit there; npm's
 * own generated .cmd/.ps1 shim is what makes `ce` runnable on that
 * platform instead), so this is portable across platforms.
 *
 * Throws if the file's first line isn't the expected shebang, so a build
 * that would otherwise produce a broken executable fails loudly instead
 * of silently.
 */
export function makeExecutable(cliPath) {
  const firstLine = readFileSync(cliPath, "utf8").split("\n", 1)[0];
  if (firstLine !== EXPECTED_SHEBANG) {
    throw new Error(
      `${cliPath} does not start with "${EXPECTED_SHEBANG}" (found: ${JSON.stringify(firstLine)}). Refusing to mark it executable.`,
    );
  }
  chmodSync(cliPath, 0o755);
}

// Only run when invoked directly (`node scripts/make-cli-executable.mjs`),
// not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  makeExecutable(cliPath);
  console.log(`dist/cli.js is executable.`);
}
