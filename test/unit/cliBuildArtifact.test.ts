import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Black-box regression test for the `npm link` / "permission denied"
 * bug: TypeScript's emitted dist/cli.js has the correct shebang but not
 * the executable bit, so `npm run build` must restore it every time.
 * Runs a real build (fast: plain `tsc`) rather than trusting a possibly
 * stale dist/ left over from a previous run.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = join(repoRoot, "dist", "cli.js");

describe("dist/cli.js build artifact", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"], { cwd: repoRoot });
  }, 30_000);

  it('starts with exactly "#!/usr/bin/env node"', async () => {
    const content = await readFile(cliPath, "utf8");
    expect(content.split("\n", 1)[0]).toBe("#!/usr/bin/env node");
  });

  it.runIf(process.platform !== "win32")(
    "is executable (owner, group, and other execute bits all set)",
    async () => {
      const { mode } = await stat(cliPath);
      expect(mode & 0o111).toBe(0o111);
    },
  );

  it("actually runs end-to-end under the current Node and prints usage", async () => {
    const result = await execa("node", [cliPath, "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: ce");
    expect(result.stdout).toContain("start [options] <repo> <issue>");
    expect(result.stdout).toContain("resume");
  });
});
