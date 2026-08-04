import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
  nonExistentOpenSpecBin,
  setupFakeOpenSpec,
  teardownFakeOpenSpec,
  type FakeOpenSpecEnv,
} from "../helpers/fakeOpenSpec.js";

describe("ce cleanup (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
    fakeOpenSpec = await setupFakeOpenSpec();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    await teardownFakeOpenSpec(fakeOpenSpec);
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("prints a clear message and exits successfully when there is no active workspace", async () => {
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(cleanupCommand({})).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith("No active workspace to clean up.");
  });

  it("refuses to clean up a dirty worktree without --force", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    await expect(cleanupCommand({})).rejects.toThrow(/tracked or untracked change/i);

    // Nothing should have been removed.
    expect(existsSync(worktreePath)).toBe(true);
    const { readActivePointer } = await import("../../src/core/workspace.js");
    expect(await readActivePointer()).not.toBeNull();
  });

  it("successfully force-cleans a dirty worktree", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    await cleanupCommand({ force: true });

    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(workspacePath)).toBe(false);

    const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
    expect(branches.stdout.trim()).toBe("");

    const { readActivePointer } = await import("../../src/core/workspace.js");
    expect(await readActivePointer()).toBeNull();

    // The original repository must remain untouched (still has its initial commit and clean tree).
    const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("cleans up a clean worktree without --force", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    await expect(cleanupCommand({})).resolves.toBeUndefined();

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("is idempotent when run twice in a row", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    await cleanupCommand({});
    await expect(cleanupCommand({})).resolves.toBeUndefined();
  });

  describe("cwd-inside-worktree protection", () => {
    it("refuses cleanup when the current working directory is the worktree root itself", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

      vi.spyOn(process, "cwd").mockReturnValue(worktreePath);

      await expect(cleanupCommand({})).rejects.toThrow(/current directory is inside the worktree/i);

      expect(existsSync(worktreePath)).toBe(true);
      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).not.toBeNull();
      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout).toContain("ce-harness/issue-1");
    });

    it("refuses cleanup when the current working directory is nested inside the worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const nestedDir = join(worktreePath, "src", "nested");
      await mkdir(nestedDir, { recursive: true });

      vi.spyOn(process, "cwd").mockReturnValue(nestedDir);

      await expect(cleanupCommand({})).rejects.toThrow(/current directory is inside the worktree/i);
      expect(existsSync(worktreePath)).toBe(true);
    });

    it("is not bypassed by --force", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

      vi.spyOn(process, "cwd").mockReturnValue(worktreePath);

      await expect(cleanupCommand({ force: true })).rejects.toThrow(
        /current directory is inside the worktree/i,
      );

      // Nothing was removed, even with --force.
      expect(existsSync(worktreePath)).toBe(true);
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(workspacePath)).toBe(true);
      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).not.toBeNull();
    });

    it("allows cleanup once the current working directory moves outside the worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(worktreePath);
      await expect(cleanupCommand({})).rejects.toThrow(/current directory is inside the worktree/i);

      cwdSpy.mockReturnValue(repoDir);
      await expect(cleanupCommand({})).resolves.toBeUndefined();
      expect(existsSync(worktreePath)).toBe(false);
    });
  });

  describe("empty project-level directory cleanup", () => {
    it("removes now-empty project directories under worktrees/ and workspaces/ after cleanup", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      await cleanupCommand({});

      const projectWorktreeDir = join(harnessHomeDir, "worktrees", basenameOf(repoDir));
      const projectWorkspaceDir = join(harnessHomeDir, "workspaces", basenameOf(repoDir));
      expect(existsSync(projectWorktreeDir)).toBe(false);
      expect(existsSync(projectWorkspaceDir)).toBe(false);

      // Top-level runtime directories must remain.
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(true);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(true);
    });

    it("preserves project directories that still contain other entries", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      // Simulate a leftover sibling directory for another issue under the
      // same project, e.g. from a previous run.
      const projectWorktreeDir = join(harnessHomeDir, "worktrees", basenameOf(repoDir));
      await mkdir(join(projectWorktreeDir, "other-issue"), { recursive: true });

      await cleanupCommand({});

      // worktrees/<project> still has "other-issue" in it, so it must survive.
      expect(existsSync(projectWorktreeDir)).toBe(true);
      expect(existsSync(join(projectWorktreeDir, "other-issue"))).toBe(true);

      // workspaces/<project> had nothing else in it, so it is removed.
      const projectWorkspaceDir = join(harnessHomeDir, "workspaces", basenameOf(repoDir));
      expect(existsSync(projectWorkspaceDir)).toBe(false);
    });
  });

  describe("OpenSpec integration", () => {
    it("unregisters the OpenSpec store before deleting the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const storeId = workspace.openSpec!.storeId;

      let registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(registry[storeId]).toBeDefined();

      await cleanupCommand({});

      registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(registry[storeId]).toBeUndefined();

      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(workspacePath)).toBe(false);
    });

    it("is idempotent when the store was already manually unregistered", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { unregisterStore } = await import("../../src/core/openspec.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      await unregisterStore(workspace.workspacePath, workspace.openSpec!.storeId);

      await expect(cleanupCommand({})).resolves.toBeUndefined();

      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(workspacePath)).toBe(false);
    });

    it("refuses cleanup (leaving the workspace and active pointer intact) when unregister fails without --force", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      process.env.FAKE_OPENSPEC_FAIL_UNREGISTER = "1";

      await expect(cleanupCommand({})).rejects.toThrow(/failed to unregister openspec store/i);

      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(workspacePath)).toBe(true);
      expect(existsSync(worktreePath)).toBe(true);

      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).not.toBeNull();
    });

    it("with --force, reports the failed unregister and still safely removes harness-owned files", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      process.env.FAKE_OPENSPEC_FAIL_UNREGISTER = "1";

      await expect(cleanupCommand({ force: true })).resolves.toBeUndefined();

      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(workspacePath)).toBe(false);
      expect(existsSync(worktreePath)).toBe(false);

      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).toBeNull();

      const errorOutput = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(errorOutput).toMatch(/failed to unregister openspec store/i);
    });

    it("never invokes `openspec store remove` (only `unregister`, which never deletes files)", async () => {
      const openspecSource = await readFile(
        new URL("../../src/core/openspec.ts", import.meta.url),
        "utf8",
      );
      expect(openspecSource).not.toMatch(/["'`]remove["'`]/);
    });

    it("never unregisters a store whose id does not match the active workspace metadata", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace, writeWorkspace } = await import("../../src/core/workspace.js");
      const { setupStore } = await import("../../src/core/openspec.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      // Register an unrelated "real" store under a totally different id,
      // simulating something else on the machine that a corrupted
      // workspace.yml might otherwise point at.
      const unrelatedRoot = join(fakeOpenSpec.dir, "unrelated-store");
      await setupStore(fakeOpenSpec.dir, "someones-important-real-store", unrelatedRoot);

      // Corrupt the workspace file to point at that unrelated store id.
      await writeWorkspace({
        ...workspace,
        openSpec: { storeId: "someones-important-real-store", root: workspace.openSpec!.root },
      });

      await expect(cleanupCommand({})).resolves.toBeUndefined();

      const registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(registry["someones-important-real-store"].root).toBe(unrelatedRoot);
    });

    it("still cleans up a legacy (v0.1) workspace with no OpenSpec metadata", async () => {
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { writeActivePointer } = await import("../../src/core/workspace.js");
      const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
        "../../src/core/paths.js"
      );
      const { addWorktree, detectBaseBranch } = await import("../../src/core/git.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const project = basenameOf(repoDir);
      const worktreePath = buildWorktreePath(project, "issue-1");
      const workspacePath = buildWorkspacePath(project, "issue-1");
      const baseBranch = await detectBaseBranch(repoDir);
      await addWorktree(repoDir, worktreePath, "ce-harness/issue-1", baseBranch!);
      await mkdir(workspacePath, { recursive: true });

      const legacyYaml = [
        `project: ${project}`,
        `repositoryPath: ${repoDir}`,
        "issue: issue-1",
        "sanitizedIssue: issue-1",
        "baseBranch: main",
        "internalBranch: ce-harness/issue-1",
        `worktreePath: ${worktreePath}`,
        `workspacePath: ${workspacePath}`,
        "createdAt: '2024-01-01T00:00:00.000Z'",
        "",
      ].join("\n");
      await writeFile(join(workspacePath, "workspace.yml"), legacyYaml, "utf8");
      await writeActivePointer({ project, sanitizedIssue: "issue-1" });

      await expect(cleanupCommand({})).resolves.toBeUndefined();

      expect(existsSync(worktreePath)).toBe(false);
      expect(existsSync(workspacePath)).toBe(false);
      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).toBeNull();
    });

    it("refuses cleanup without --force when the openspec executable is unavailable but trusted metadata exists", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      process.env.CE_OPENSPEC_BIN = nonExistentOpenSpecBin(fakeOpenSpec.dir);

      await expect(cleanupCommand({})).rejects.toThrow(/openspec.*not available/i);

      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(workspacePath)).toBe(true);
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
