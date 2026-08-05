import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeExecutable } from "../../scripts/make-cli-executable.mjs";

describe("makeExecutable (scripts/make-cli-executable.mjs)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ce-harness-make-executable-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sets the executable bit on a file with the expected shebang", async () => {
    const filePath = join(dir, "cli.js");
    await writeFile(filePath, "#!/usr/bin/env node\nconsole.log('hi');\n", "utf8");
    // Starts non-executable, matching tsc's actual emitted output.
    const { chmodSync } = await import("node:fs");
    chmodSync(filePath, 0o644);
    expect(statSync(filePath).mode & 0o111).toBe(0);

    makeExecutable(filePath);

    expect(statSync(filePath).mode & 0o111).toBe(0o111);
  });

  it("is idempotent (safe to call twice)", async () => {
    const filePath = join(dir, "cli.js");
    await writeFile(filePath, "#!/usr/bin/env node\nconsole.log('hi');\n", "utf8");

    makeExecutable(filePath);
    makeExecutable(filePath);

    expect(statSync(filePath).mode & 0o111).toBe(0o111);
  });

  it("throws and does not chmod when the shebang is missing", async () => {
    const filePath = join(dir, "cli.js");
    await writeFile(filePath, "console.log('no shebang');\n", "utf8");

    expect(() => makeExecutable(filePath)).toThrow(/does not start with/);
    expect(statSync(filePath).mode & 0o111).toBe(0);
  });

  it("throws when the shebang line is present but not exactly the expected one", async () => {
    const filePath = join(dir, "cli.js");
    await writeFile(filePath, "#!/bin/sh\necho hi\n", "utf8");

    expect(() => makeExecutable(filePath)).toThrow(/does not start with/);
  });

  it("throws (and never silently succeeds) for a nonexistent file", () => {
    const filePath = join(dir, "does-not-exist.js");
    expect(existsSync(filePath)).toBe(false);
    expect(() => makeExecutable(filePath)).toThrow();
  });
});
