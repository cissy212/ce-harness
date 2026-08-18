import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function baseWorkspace(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project: "demo",
    repositoryPath: "/tmp/demo-repo",
    issue: "Issue #1",
    sanitizedIssue: "issue-1",
    baseBranch: "main",
    internalBranch: "ce-harness/issue-1",
    worktreePath: "/tmp/demo-worktree",
    workspacePath: "/tmp/demo-workspace",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("buildLaunchEnv", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ce-harness-launchenv-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("builds the core CE_* vars and OPENCODE_CONFIG_DIR from the workspace paths, with no OpenSpec/diff/CodeGraph fields when absent", async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const workspace = baseWorkspace({
      workspacePath: join(tempDir, "workspace"),
      worktreePath: join(tempDir, "worktree"),
    });

    const env = buildLaunchEnv(workspace);

    expect(env.CE_WORKSPACE).toBe(join(tempDir, "workspace"));
    expect(env.CE_WORKTREE).toBe(join(tempDir, "worktree"));
    expect(env.CE_PROJECT).toBe("demo");
    expect(env.CE_ISSUE).toBe("Issue #1");
    expect(env.CE_LENSES_DIR).toBe(join(tempDir, "workspace", "lenses"));
    expect(env.OPENCODE_CONFIG_DIR).toBe(join(tempDir, "workspace", "opencode"));
    expect(env.CE_OPENSPEC_STORE).toBeUndefined();
    expect(env.CE_DIFF_BASE).toBeUndefined();
    expect(env.CE_DIFF_HEAD).toBeUndefined();
    expect(env.CE_CODE_NAV_AVAILABLE).toBeUndefined();
    expect(env.CE_CODE_NAV_PROVIDER).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });

  it("uses CE_ISSUE from the raw `issue` field, not `sanitizedIssue`", async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const workspace = baseWorkspace({ issue: "Fix Bug #42", sanitizedIssue: "fix-bug-42" });

    const env = buildLaunchEnv(workspace);

    expect(env.CE_ISSUE).toBe("Fix Bug #42");
  });

  it("includes CE_OPENSPEC_STORE only when the persisted openSpec metadata is trusted (cross-checked)", async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const { expectedOpenSpecRoot } = await import("../../src/core/openspecId.js");
    const workspacePath = join(tempDir, "workspace");

    // Trusted: storeId/root match what ce-harness would itself generate.
    const { generateStoreId } = await import("../../src/core/openspecId.js");
    const repositoryPath = "/tmp/demo-repo";
    const trustedStoreId = generateStoreId("demo", "issue-1", repositoryPath);
    const trustedWorkspace = baseWorkspace({
      workspacePath,
      repositoryPath,
      openSpec: { storeId: trustedStoreId, root: expectedOpenSpecRoot(workspacePath) },
    });
    expect(buildLaunchEnv(trustedWorkspace).CE_OPENSPEC_STORE).toBe(trustedStoreId);

    // Untrusted: storeId doesn't match what would be regenerated -- omitted,
    // never trusted blindly.
    const untrustedWorkspace = baseWorkspace({
      workspacePath,
      repositoryPath,
      openSpec: { storeId: "ce-tampered-id-00000000", root: expectedOpenSpecRoot(workspacePath) },
    });
    expect(buildLaunchEnv(untrustedWorkspace).CE_OPENSPEC_STORE).toBeUndefined();
  });

  it("includes CE_DIFF_BASE/CE_DIFF_HEAD only when both are present", async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const workspace = baseWorkspace({
      diffBase: "a".repeat(40),
      diffHead: "b".repeat(40),
    });

    const env = buildLaunchEnv(workspace);

    expect(env.CE_DIFF_BASE).toBe("a".repeat(40));
    expect(env.CE_DIFF_HEAD).toBe("b".repeat(40));
  });

  it("includes CE_CODE_NAV_* and OPENCODE_CONFIG only when CodeGraph metadata is trusted AND the index still exists on disk", async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const worktreePath = join(tempDir, "worktree");
    const indexPath = join(worktreePath, ".codegraph");
    await mkdir(indexPath, { recursive: true });

    const trustedWorkspace = baseWorkspace({
      worktreePath,
      workspacePath: join(tempDir, "workspace"),
      codeGraph: {
        available: true,
        managedByHarness: true,
        indexPath,
        initializedAt: new Date().toISOString(),
      },
    });

    const env = buildLaunchEnv(trustedWorkspace);
    expect(env.CE_CODE_NAV_AVAILABLE).toBe("1");
    expect(env.CE_CODE_NAV_PROVIDER).toBe("codegraph");
    expect(env.OPENCODE_CONFIG).toBe(join(tempDir, "workspace", "opencode", "opencode.json"));
  });

  it("omits CE_CODE_NAV_* when the recorded index no longer exists on disk (e.g. manually deleted)", async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const worktreePath = join(tempDir, "worktree");
    const indexPath = join(worktreePath, ".codegraph"); // never created on disk

    const workspace = baseWorkspace({
      worktreePath,
      codeGraph: {
        available: true,
        managedByHarness: true,
        indexPath,
        initializedAt: new Date().toISOString(),
      },
    });

    const env = buildLaunchEnv(workspace);
    expect(env.CE_CODE_NAV_AVAILABLE).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });

  it("omits CE_CODE_NAV_* when CodeGraph metadata is not managed by harness (pre-existing index case)", async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const worktreePath = join(tempDir, "worktree");
    const indexPath = join(worktreePath, ".codegraph");
    await mkdir(indexPath, { recursive: true });

    const workspace = baseWorkspace({
      worktreePath,
      codeGraph: {
        available: false,
        managedByHarness: false,
        reason: 'A ".codegraph" directory already exists in this worktree.',
      },
    });

    const env = buildLaunchEnv(workspace);
    expect(env.CE_CODE_NAV_AVAILABLE).toBeUndefined();
  });

  it('delegates runner-specific env vars to the resolved runner: workspace.runner = "claude" omits OPENCODE_CONFIG_DIR entirely', async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const workspace = baseWorkspace({
      workspacePath: join(tempDir, "workspace"),
      worktreePath: join(tempDir, "worktree"),
      runner: "claude",
    });

    const env = buildLaunchEnv(workspace);

    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    // The generic CE_* contract is unaffected by which runner is selected.
    expect(env.CE_WORKSPACE).toBe(join(tempDir, "workspace"));
    expect(env.CE_LENSES_DIR).toBe(join(tempDir, "workspace", "lenses"));
  });

  it('workspace.runner = "opencode" behaves exactly like an absent runner field', async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const workspaceWithId = baseWorkspace({
      workspacePath: join(tempDir, "workspace"),
      worktreePath: join(tempDir, "worktree"),
      runner: "opencode",
    });
    const workspaceWithoutField = baseWorkspace({
      workspacePath: join(tempDir, "workspace"),
      worktreePath: join(tempDir, "worktree"),
    });

    expect(buildLaunchEnv(workspaceWithId)).toEqual(buildLaunchEnv(workspaceWithoutField));
  });

  it("never mutates the workspace object it's given", async () => {
    const { buildLaunchEnv } = await import("../../src/core/launchEnv.js");
    const workspace = baseWorkspace({ diffBase: "a".repeat(40), diffHead: "b".repeat(40) });
    const snapshot = JSON.parse(JSON.stringify(workspace));

    buildLaunchEnv(workspace);

    expect(workspace).toEqual(snapshot);
  });
});
