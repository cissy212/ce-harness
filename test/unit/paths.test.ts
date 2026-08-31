import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("paths", () => {
  let tempHome: string;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ce-harness-paths-"));
    process.env.CE_HARNESS_HOME = tempHome;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("honors CE_HARNESS_HOME for the harness home root", async () => {
    const { harnessHome } = await import("../../src/core/paths.js");
    expect(harnessHome()).toBe(tempHome);
  });

  it("constructs worktree and workspace paths under project/issue", async () => {
    const { worktreePath, workspacePath, worktreesRoot, workspacesRoot } = await import(
      "../../src/core/paths.js"
    );
    expect(worktreePath("proj", "issue-1")).toBe(join(worktreesRoot(), "proj", "issue-1"));
    expect(workspacePath("proj", "issue-1")).toBe(join(workspacesRoot(), "proj", "issue-1"));
  });

  it("openspecRoot() is a sibling of worktreesRoot()/workspacesRoot(), never nested under either", async () => {
    const { openspecRoot, worktreesRoot, workspacesRoot, harnessHome } = await import(
      "../../src/core/paths.js"
    );
    expect(openspecRoot()).toBe(join(harnessHome(), "openspec"));
    expect(openspecRoot().startsWith(worktreesRoot())).toBe(false);
    expect(openspecRoot().startsWith(workspacesRoot())).toBe(false);
    expect(worktreesRoot().startsWith(openspecRoot())).toBe(false);
    expect(workspacesRoot().startsWith(openspecRoot())).toBe(false);
  });

  it("removeEmptyProjectDir() never removes openspecRoot() itself, even if empty", async () => {
    const { removeEmptyProjectDir, openspecRoot } = await import("../../src/core/paths.js");
    const { mkdir } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");

    await mkdir(openspecRoot(), { recursive: true });
    await removeEmptyProjectDir(openspecRoot());
    expect(existsSync(openspecRoot())).toBe(true);
  });

  it("allows a path exactly at the harness home root", async () => {
    const { assertInsideHarnessHome, harnessHome } = await import("../../src/core/paths.js");
    await expect(assertInsideHarnessHome(harnessHome())).resolves.toBeUndefined();
  });

  it("allows nested paths inside the harness home root, even if not yet existing", async () => {
    const { assertInsideHarnessHome } = await import("../../src/core/paths.js");
    await expect(
      assertInsideHarnessHome(join(tempHome, "worktrees", "proj", "issue-1")),
    ).resolves.toBeUndefined();
  });

  it("rejects a path outside the harness home root", async () => {
    const { assertInsideHarnessHome } = await import("../../src/core/paths.js");
    await expect(assertInsideHarnessHome(tmpdir())).rejects.toThrow();
  });

  it("rejects a path that escapes the root via traversal", async () => {
    const { assertInsideHarnessHome } = await import("../../src/core/paths.js");
    await expect(
      assertInsideHarnessHome(join(tempHome, "worktrees", "..", "..", "etc")),
    ).rejects.toThrow();
  });

  it("rejects the real repository directory even if referenced through the harness home", async () => {
    const { assertInsideHarnessHome } = await import("../../src/core/paths.js");
    await expect(assertInsideHarnessHome(process.cwd())).rejects.toThrow();
  });
});
