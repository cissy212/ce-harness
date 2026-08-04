import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("workspace serialization and validation", () => {
  let tempHome: string;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ce-harness-workspace-"));
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

  it("round-trips a workspace through writeWorkspace/readWorkspace", async () => {
    const { writeWorkspace, readWorkspace } = await import("../../src/core/workspace.js");
    const workspace = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "Issue #1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: join(tempHome, "worktrees", "demo", "issue-1"),
      workspacePath: join(tempHome, "workspaces", "demo", "issue-1"),
      createdAt: new Date().toISOString(),
    };

    await writeWorkspace(workspace);
    const loaded = await readWorkspace("demo", "issue-1");
    expect(loaded).toEqual(workspace);
  });

  it("throws a CeError when the workspace file is missing", async () => {
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const { CeError } = await import("../../src/core/errors.js");
    await expect(readWorkspace("nope", "nope")).rejects.toThrow(CeError);
  });

  it("throws a CeError when the workspace file has invalid schema", async () => {
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const { CeError } = await import("../../src/core/errors.js");
    const dir = join(tempHome, "workspaces", "demo", "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspace.yml"), "project: demo\n", "utf8");
    await expect(readWorkspace("demo", "bad")).rejects.toThrow(CeError);
  });

  it("throws a CeError when the workspace file is not valid YAML", async () => {
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const { CeError } = await import("../../src/core/errors.js");
    const dir = join(tempHome, "workspaces", "demo", "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspace.yml"), "project: [unterminated", "utf8");
    await expect(readWorkspace("demo", "broken")).rejects.toThrow(CeError);
  });

  it("round-trips the active workspace pointer", async () => {
    const { writeActivePointer, readActivePointer, clearActivePointer } = await import(
      "../../src/core/workspace.js"
    );
    expect(await readActivePointer()).toBeNull();

    await writeActivePointer({ project: "demo", sanitizedIssue: "issue-1" });
    expect(await readActivePointer()).toEqual({ project: "demo", sanitizedIssue: "issue-1" });

    await clearActivePointer();
    expect(await readActivePointer()).toBeNull();
  });
});
