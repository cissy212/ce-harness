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

  it("round-trips a workspace that includes OpenSpec metadata", async () => {
    const { writeWorkspace, readWorkspace } = await import("../../src/core/workspace.js");
    const workspacePath = join(tempHome, "workspaces", "demo", "issue-1");
    const workspace = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "Issue #1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: join(tempHome, "worktrees", "demo", "issue-1"),
      workspacePath,
      createdAt: new Date().toISOString(),
      openSpec: {
        storeId: "ce-demo-issue-1-abcd1234",
        root: join(workspacePath, "openspec"),
      },
    };

    await writeWorkspace(workspace);
    const loaded = await readWorkspace("demo", "issue-1");
    expect(loaded).toEqual(workspace);
  });

  it("rejects OpenSpec metadata with a missing storeId or root", async () => {
    const { WorkspaceSchema } = await import("../../src/core/workspace.js");
    const base = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "Issue #1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: "/tmp/wt",
      workspacePath: "/tmp/ws",
      createdAt: new Date().toISOString(),
    };

    expect(WorkspaceSchema.safeParse({ ...base, openSpec: {} }).success).toBe(false);
    expect(WorkspaceSchema.safeParse({ ...base, openSpec: { storeId: "x" } }).success).toBe(false);
    expect(
      WorkspaceSchema.safeParse({ ...base, openSpec: { storeId: "x", root: "/tmp/ws/openspec" } })
        .success,
    ).toBe(true);
  });

  it("still parses a legacy (v0.1) workspace file with no openSpec field", async () => {
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const dir = join(tempHome, "workspaces", "demo", "legacy");
    await mkdir(dir, { recursive: true });
    const legacyYaml = [
      "project: demo",
      "repositoryPath: /tmp/demo",
      "issue: issue-1",
      "sanitizedIssue: issue-1",
      "baseBranch: main",
      "internalBranch: ce-harness/issue-1",
      `worktreePath: ${join(tempHome, "worktrees", "demo", "legacy")}`,
      `workspacePath: ${dir}`,
      "createdAt: '2024-01-01T00:00:00.000Z'",
      "",
    ].join("\n");
    await writeFile(join(dir, "workspace.yml"), legacyYaml, "utf8");

    const loaded = await readWorkspace("demo", "legacy");
    expect(loaded.openSpec).toBeUndefined();
  });

  it("resolveTrustedOpenSpec returns null for a legacy workspace with no openSpec block", async () => {
    const { resolveTrustedOpenSpec } = await import("../../src/core/workspace.js");
    const workspace = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "issue-1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: "/tmp/wt",
      workspacePath: "/tmp/ws",
      createdAt: new Date().toISOString(),
    };
    expect(resolveTrustedOpenSpec(workspace)).toBeNull();
  });

  it("resolveTrustedOpenSpec trusts metadata that matches the deterministic id and expected root", async () => {
    const { resolveTrustedOpenSpec } = await import("../../src/core/workspace.js");
    const { generateStoreId, expectedOpenSpecRoot } = await import("../../src/core/openspecId.js");
    const workspacePath = "/tmp/ws/demo/issue-1";
    const workspace = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "issue-1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: "/tmp/wt",
      workspacePath,
      createdAt: new Date().toISOString(),
      openSpec: {
        storeId: generateStoreId("demo", "issue-1", "/tmp/demo"),
        root: expectedOpenSpecRoot(workspacePath),
      },
    };
    expect(resolveTrustedOpenSpec(workspace)).toEqual(workspace.openSpec);
  });

  it("resolveTrustedOpenSpec rejects metadata with a storeId that doesn't match the deterministic id", async () => {
    const { resolveTrustedOpenSpec } = await import("../../src/core/workspace.js");
    const { expectedOpenSpecRoot } = await import("../../src/core/openspecId.js");
    const workspacePath = "/tmp/ws/demo/issue-1";
    const workspace = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "issue-1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: "/tmp/wt",
      workspacePath,
      createdAt: new Date().toISOString(),
      openSpec: {
        // Attacker-controlled/corrupted: some unrelated, real store id.
        storeId: "someones-important-real-store",
        root: expectedOpenSpecRoot(workspacePath),
      },
    };
    expect(resolveTrustedOpenSpec(workspace)).toBeNull();
  });

  it("resolveTrustedOpenSpec rejects metadata whose root does not match <workspacePath>/openspec", async () => {
    const { resolveTrustedOpenSpec } = await import("../../src/core/workspace.js");
    const { generateStoreId } = await import("../../src/core/openspecId.js");
    const workspacePath = "/tmp/ws/demo/issue-1";
    const workspace = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "issue-1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: "/tmp/wt",
      workspacePath,
      createdAt: new Date().toISOString(),
      openSpec: {
        storeId: generateStoreId("demo", "issue-1", "/tmp/demo"),
        root: "/etc/somewhere-else",
      },
    };
    expect(resolveTrustedOpenSpec(workspace)).toBeNull();
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

  it("round-trips a workspace with an explicit diff review range", async () => {
    const { writeWorkspace, readWorkspace } = await import("../../src/core/workspace.js");
    const workspace = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "review-pr-116",
      sanitizedIssue: "review-pr-116",
      baseBranch: "a".repeat(40),
      internalBranch: "ce-harness/review-pr-116",
      worktreePath: join(tempHome, "worktrees", "demo", "review-pr-116"),
      workspacePath: join(tempHome, "workspaces", "demo", "review-pr-116"),
      createdAt: new Date().toISOString(),
      diffBase: "b".repeat(40),
      diffHead: "a".repeat(40),
      diffMergeBase: "c".repeat(40),
    };

    await writeWorkspace(workspace);
    const loaded = await readWorkspace("demo", "review-pr-116");
    expect(loaded).toEqual(workspace);
  });

  it("a legacy workspace with no diffBase/diffHead/diffMergeBase fields remains valid", async () => {
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const dir = join(tempHome, "workspaces", "demo", "legacy-no-diff");
    await mkdir(dir, { recursive: true });
    const legacyYaml = [
      "project: demo",
      "repositoryPath: /tmp/demo",
      "issue: issue-1",
      "sanitizedIssue: issue-1",
      "baseBranch: main",
      "internalBranch: ce-harness/issue-1",
      `worktreePath: ${join(tempHome, "worktrees", "demo", "legacy-no-diff")}`,
      `workspacePath: ${dir}`,
      "createdAt: '2024-01-01T00:00:00.000Z'",
      "",
    ].join("\n");
    await writeFile(join(dir, "workspace.yml"), legacyYaml, "utf8");

    const loaded = await readWorkspace("demo", "legacy-no-diff");
    expect(loaded.diffBase).toBeUndefined();
    expect(loaded.diffHead).toBeUndefined();
    expect(loaded.diffMergeBase).toBeUndefined();
  });

  it("rejects diffBase without diffHead (and vice versa)", async () => {
    const { WorkspaceSchema } = await import("../../src/core/workspace.js");
    const base = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "issue-1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: "/tmp/wt",
      workspacePath: "/tmp/ws",
      createdAt: new Date().toISOString(),
    };

    expect(WorkspaceSchema.safeParse({ ...base, diffBase: "a".repeat(40) }).success).toBe(false);
    expect(WorkspaceSchema.safeParse({ ...base, diffHead: "a".repeat(40) }).success).toBe(false);
    expect(
      WorkspaceSchema.safeParse({ ...base, diffBase: "a".repeat(40), diffHead: "b".repeat(40) })
        .success,
    ).toBe(true);
  });

  it("rejects diffMergeBase without diffBase and diffHead also present", async () => {
    const { WorkspaceSchema } = await import("../../src/core/workspace.js");
    const base = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "issue-1",
      sanitizedIssue: "issue-1",
      baseBranch: "main",
      internalBranch: "ce-harness/issue-1",
      worktreePath: "/tmp/wt",
      workspacePath: "/tmp/ws",
      createdAt: new Date().toISOString(),
    };

    expect(WorkspaceSchema.safeParse({ ...base, diffMergeBase: "c".repeat(40) }).success).toBe(
      false,
    );
    expect(
      WorkspaceSchema.safeParse({
        ...base,
        diffBase: "a".repeat(40),
        diffHead: "b".repeat(40),
        diffMergeBase: "c".repeat(40),
      }).success,
    ).toBe(true);
  });

  it("accepts baseBranchCommit alone, but rejects it together with diffBase (already captures the same fact)", async () => {
    const { WorkspaceSchema } = await import("../../src/core/workspace.js");
    const base = {
      project: "demo",
      repositoryPath: "/tmp/demo",
      issue: "issue-1",
      sanitizedIssue: "issue-1",
      baseBranch: "develop",
      internalBranch: "ce-harness/issue-1",
      worktreePath: "/tmp/wt",
      workspacePath: "/tmp/ws",
      createdAt: new Date().toISOString(),
    };

    expect(
      WorkspaceSchema.safeParse({ ...base, baseBranchCommit: "d".repeat(40) }).success,
    ).toBe(true);
    expect(WorkspaceSchema.safeParse(base).success).toBe(true);
    expect(
      WorkspaceSchema.safeParse({
        ...base,
        baseBranchCommit: "d".repeat(40),
        diffBase: "a".repeat(40),
        diffHead: "b".repeat(40),
      }).success,
    ).toBe(false);
  });
});

describe("workspaceType", () => {
  const base = {
    project: "demo",
    repositoryPath: "/tmp/demo",
    issue: "issue-1",
    sanitizedIssue: "issue-1",
    baseBranch: "main",
    internalBranch: "ce-harness/issue-1",
    worktreePath: "/tmp/wt",
    workspacePath: "/tmp/ws",
    createdAt: new Date().toISOString(),
  };

  it('is "Implementation" when diffBase/diffHead are absent (the default flow)', async () => {
    const { workspaceType } = await import("../../src/core/workspace.js");
    expect(workspaceType(base)).toBe("Implementation");
  });

  it('is "Existing PR review" when both diffBase and diffHead are present', async () => {
    const { workspaceType } = await import("../../src/core/workspace.js");
    const workspace = { ...base, diffBase: "a".repeat(40), diffHead: "b".repeat(40) };
    expect(workspaceType(workspace)).toBe("Existing PR review");
  });
});
