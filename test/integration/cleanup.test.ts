import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  setupFakeOpenCode,
  teardownFakeOpenCode,
  type FakeOpenCodeEnv,
} from "../helpers/fakeOpenCode.js";
import { nonExistentCodeGraphBin } from "../helpers/fakeCodeGraph.js";
import {
  nonExistentDockerBin,
  setupFakeDocker,
  setupFakeDockerNotInstalled,
  setupFakeDockerUnavailable,
  teardownFakeDocker,
} from "../helpers/fakeDocker.js";
import { deregisterWorktreeBookkeeping } from "../helpers/deregisterWorktree.js";

describe("ce cleanup (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  let fakeOpenCode: FakeOpenCodeEnv;
  const originalEnv = process.env.CE_HARNESS_HOME;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
    fakeOpenSpec = await setupFakeOpenSpec();
    fakeOpenCode = await setupFakeOpenCode();
    // Deterministic regardless of whether this machine happens to have
    // the real `codegraph` on PATH -- CodeGraph behavior itself is
    // covered by test/integration/codeGraph.test.ts.
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
    // Deterministic regardless of whether this machine happens to have
    // Docker installed/running, and regardless of what containers
    // happen to exist on it -- never touches a real Docker installation
    // unless a specific test opts into the fake one below.
    process.env.CE_DOCKER_BIN = nonExistentDockerBin();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    process.exitCode = originalExitCode;
    await teardownFakeOpenSpec(fakeOpenSpec);
    await teardownFakeOpenCode(fakeOpenCode);
    delete process.env.CE_CODEGRAPH_BIN;
    teardownFakeDocker();
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

  it("cleans up a workspace created with an explicit --base/--head review range identically to the default flow", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    const { readActivePointer } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
    await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
    await writeFile(join(repoDir, "feature.txt"), "new feature\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "feature commit"]);
    const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
    await execa("git", ["-C", repoDir, "checkout", "main"]);

    await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: headSha });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(workspacePath)).toBe(true);

    await expect(cleanupCommand({})).resolves.toBeUndefined();

    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(workspacePath)).toBe(false);
    expect(await readActivePointer()).toBeNull();

    // The original repository must remain untouched.
    const branch = await execa("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout.trim()).toBe("main");
    const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("is idempotent when run twice in a row", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    await cleanupCommand({});
    await expect(cleanupCommand({})).resolves.toBeUndefined();
  });

  describe("Idempotent cleanup when Git resources are already missing (regression)", () => {
    it("succeeds when the worktree is already missing but the branch still exists", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");

      // Simulate the worktree already having been removed some other
      // way (manually, or by an interrupted previous cleanup), while
      // the branch is left fully intact -- exactly as `ce status` would
      // report "Worktree exists: no" / "Branch exists: yes".
      await execa("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath]);
      expect(existsSync(worktreePath)).toBe(false);
      const branchesBefore = await execa("git", [
        "-C",
        repoDir,
        "branch",
        "--list",
        "ce-harness/issue-1",
      ]);
      expect(branchesBefore.stdout).toContain("ce-harness/issue-1");

      await expect(cleanupCommand({})).resolves.toBeUndefined();

      const branchesAfter = await execa("git", [
        "-C",
        repoDir,
        "branch",
        "--list",
        "ce-harness/issue-1",
      ]);
      expect(branchesAfter.stdout.trim()).toBe("");
      expect(existsSync(workspacePath)).toBe(false);
      expect(await readActivePointer()).toBeNull();
    });

    it("succeeds when the branch is already missing but the worktree still exists", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");

      // `git branch -D` itself refuses to delete a branch still checked
      // out in a worktree, so first detach the worktree's HEAD (e.g. as
      // if some tool inside it had done its own detached checkout) to
      // free the branch up, then delete it normally -- leaving a
      // perfectly clean worktree that is simply no longer on that
      // branch, exactly as `ce status` would report "Worktree exists:
      // yes" / "Branch exists: no".
      await execa("git", ["-C", worktreePath, "checkout", "--detach"]);
      await execa("git", ["-C", repoDir, "branch", "-D", "ce-harness/issue-1"]);
      const showRef = await execa(
        "git",
        ["-C", repoDir, "show-ref", "--verify", "--quiet", "refs/heads/ce-harness/issue-1"],
        { reject: false },
      );
      expect(showRef.exitCode).not.toBe(0);
      expect(existsSync(worktreePath)).toBe(true);
      const statusBefore = await execa("git", ["-C", worktreePath, "status", "--porcelain"]);
      expect(statusBefore.stdout).toBe("");

      await expect(cleanupCommand({})).resolves.toBeUndefined();

      expect(existsSync(worktreePath)).toBe(false);
      expect(existsSync(workspacePath)).toBe(false);
      expect(await readActivePointer()).toBeNull();
    });

    it("succeeds when BOTH the worktree and the branch are already missing (the exact reported scenario)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");

      // Remove the worktree first (a normal branch delete works fine
      // once nothing has it checked out), then the branch -- exactly
      // `ce status` reporting "Worktree exists: no" / "Branch exists: no"
      // while the active workspace pointer and workspace.yml are still
      // present.
      await execa("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath]);
      await execa("git", ["-C", repoDir, "branch", "-D", "ce-harness/issue-1"]);
      expect(existsSync(worktreePath)).toBe(false);
      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout.trim()).toBe("");

      await expect(cleanupCommand({})).resolves.toBeUndefined();

      expect(existsSync(workspacePath)).toBe(false);
      expect(await readActivePointer()).toBeNull();
    });

    it("repeated cleanup after both resources were already missing stays idempotent -- the second call is a clean no-op", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      await execa("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath]);
      await execa("git", ["-C", repoDir, "branch", "-D", "ce-harness/issue-1"]);

      await expect(cleanupCommand({})).resolves.toBeUndefined();
      expect(await readActivePointer()).toBeNull();

      logSpy.mockClear();
      await expect(cleanupCommand({})).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith("No active workspace to clean up.");
      expect(await readActivePointer()).toBeNull();
    });
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
      await addWorktree(repoDir, worktreePath, "ce-harness/issue-1", baseBranch!.ref);
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

  describe("OpenCode config cleanup", () => {
    it("removes the generated OpenCode config directory together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const configDir = join(workspace.workspacePath, "opencode");
      expect(existsSync(configDir)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(configDir)).toBe(false);
      expect(existsSync(workspace.workspacePath)).toBe(false);
    });

    it("removes copied command template files (e.g. workspace.md) together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedCommandFile = join(workspace.workspacePath, "opencode", "commands", "workspace.md");
      expect(existsSync(copiedCommandFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(copiedCommandFile)).toBe(false);
    });

    it("removes the copied explore.md command file together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedExploreFile = join(workspace.workspacePath, "opencode", "commands", "explore.md");
      expect(existsSync(copiedExploreFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(copiedExploreFile)).toBe(false);
    });

    it("removes the copied propose.md command file together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedProposeFile = join(workspace.workspacePath, "opencode", "commands", "propose.md");
      expect(existsSync(copiedProposeFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(copiedProposeFile)).toBe(false);
    });

    it("removes the copied apply.md command file together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedApplyFile = join(workspace.workspacePath, "opencode", "commands", "apply.md");
      expect(existsSync(copiedApplyFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(copiedApplyFile)).toBe(false);
    });

    it("removes the copied archive.md command file together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedArchiveFile = join(workspace.workspacePath, "opencode", "commands", "archive.md");
      expect(existsSync(copiedArchiveFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(copiedArchiveFile)).toBe(false);
    });

    it("removes the copied openspec-sync-specs skill directory together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedSkillFile = join(
        workspace.workspacePath,
        "opencode",
        "skills",
        "openspec-sync-specs",
        "SKILL.md",
      );
      expect(existsSync(copiedSkillFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(copiedSkillFile)).toBe(false);
    });

    it("removes the copied verify.md command file together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedVerifyFile = join(workspace.workspacePath, "opencode", "commands", "verify.md");
      expect(existsSync(copiedVerifyFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(copiedVerifyFile)).toBe(false);
    });

    it("removes the copied adversarial-review.md command file together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedAdversarialReviewFile = join(
        workspace.workspacePath,
        "opencode",
        "commands",
        "adversarial-review.md",
      );
      expect(existsSync(copiedAdversarialReviewFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(copiedAdversarialReviewFile)).toBe(false);
    });

    it("removes the canonical lenses directory (e.g. backend-developer.md, pipeline-data-engineer.md) together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const lensesDir = join(workspace.workspacePath, "lenses");
      const backendDeveloperFile = join(lensesDir, "backend-developer.md");
      const pipelineDataEngineerFile = join(lensesDir, "pipeline-data-engineer.md");
      expect(existsSync(lensesDir)).toBe(true);
      expect(existsSync(backendDeveloperFile)).toBe(true);
      expect(existsSync(pipelineDataEngineerFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(lensesDir)).toBe(false);
      expect(existsSync(backendDeveloperFile)).toBe(false);
      expect(existsSync(pipelineDataEngineerFile)).toBe(false);
    });

    it("removes the OpenCode-mirrored lens files under opencode/agents/ together with the workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const mirroredFile = join(workspace.workspacePath, "opencode", "agents", "backend-developer.md");
      expect(existsSync(mirroredFile)).toBe(true);

      await cleanupCommand({});

      expect(existsSync(mirroredFile)).toBe(false);
    });

    it("still cleans up a legacy workspace that never had an OpenCode config directory", async () => {
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
      await addWorktree(repoDir, worktreePath, "ce-harness/issue-1", baseBranch!.ref);
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

      expect(existsSync(join(workspacePath, "opencode"))).toBe(false);

      await expect(cleanupCommand({})).resolves.toBeUndefined();

      expect(existsSync(worktreePath)).toBe(false);
      expect(existsSync(workspacePath)).toBe(false);
      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).toBeNull();
    });
  });

  describe("Docker safety check (running container bind-mounted inside the worktree)", () => {
    it("aborts BEFORE touching Git/workspace state when a running container is bind-mounted inside the worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readActivePointer, readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      setupFakeDocker([
        {
          id: "abc123",
          name: "scv-ai-frontend",
          mounts: [{ source: join(workspace.worktreePath, "packages/scv-ai/frontend"), type: "bind" }],
        },
      ]);

      const registryBefore = await readFile(fakeOpenSpec.registryFile, "utf8");

      await expect(cleanupCommand({})).rejects.toThrow(/running docker container/i);

      // Nothing was mutated: worktree, branch, workspace dir, active
      // pointer, and the OpenSpec registration are all exactly as they
      // were before this call.
      expect(existsSync(workspace.worktreePath)).toBe(true);
      expect(existsSync(workspace.workspacePath)).toBe(true);
      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout).toContain("ce-harness/issue-1");
      expect(await readActivePointer()).toEqual({ project: basenameOf(repoDir), sanitizedIssue: "issue-1" });
      expect(await readFile(fakeOpenSpec.registryFile, "utf8")).toBe(registryBefore);
    });

    it("names the blocking container in the error", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      setupFakeDocker([
        {
          id: "abc123",
          name: "scv-ai-frontend",
          mounts: [{ source: join(workspace.worktreePath, "packages/scv-ai/frontend"), type: "bind" }],
        },
      ]);

      await expect(cleanupCommand({})).rejects.toThrow(/scv-ai-frontend/);
    });

    it("--force does not bypass the Docker check (force only ever means \"discard uncommitted changes\")", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      setupFakeDocker([
        { id: "abc123", name: "blocker", mounts: [{ source: workspace.worktreePath, type: "bind" }] },
      ]);

      await expect(cleanupCommand({ force: true })).rejects.toThrow(/running docker container/i);
      expect(existsSync(workspace.worktreePath)).toBe(true);
    });

    it("a container mounted at an unrelated, merely similarly-named path never blocks cleanup", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      setupFakeDocker([
        // A sibling path that merely shares a string prefix with the
        // worktree path (e.g. "…/issue-1" vs "…/issue-10") must never
        // be treated as "inside" it.
        { id: "abc123", name: "unrelated", mounts: [{ source: `${workspace.worktreePath}0`, type: "bind" }] },
      ]);

      await expect(cleanupCommand({})).resolves.toBeUndefined();
      expect(existsSync(workspace.worktreePath)).toBe(false);
    });

    it("a container mounted via a named volume (not a bind mount) never blocks cleanup", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      setupFakeDocker([
        {
          id: "abc123",
          name: "unrelated",
          mounts: [{ source: join(workspace.worktreePath, "node_modules"), type: "volume" }],
        },
      ]);

      await expect(cleanupCommand({})).resolves.toBeUndefined();
    });

    it("proceeds with normal cleanup when Docker is not installed", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      setupFakeDockerNotInstalled();

      await expect(cleanupCommand({})).resolves.toBeUndefined();
    });

    it("proceeds with normal cleanup when the Docker daemon is unreachable", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      setupFakeDockerUnavailable();

      await expect(cleanupCommand({})).resolves.toBeUndefined();
    });

    it("proceeds with normal cleanup when Docker reports no running containers at all", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      setupFakeDocker([]);

      await expect(cleanupCommand({})).resolves.toBeUndefined();
    });
  });

  describe("Partial Git worktree-removal recovery (recoverFromWorktreeRemovalFailure)", () => {
    it("still-registered worktree: rethrows the original error, preserving everything", async () => {
      const { recoverFromWorktreeRemovalFailure } = await import("../../src/commands/cleanup.js");
      const originalError = new Error("simulated git worktree remove failure");

      // A real, currently-registered worktree -- `isRegisteredWorktree`
      // must see it as such.
      const worktreePath = join(harnessHomeDir, "still-registered-wt");
      await execa("git", ["-C", repoDir, "worktree", "add", "-b", "still-registered", worktreePath, "main"]);

      await expect(
        recoverFromWorktreeRemovalFailure(repoDir, worktreePath, false, originalError),
      ).rejects.toBe(originalError);

      // Nothing about the worktree itself was touched by the recovery path.
      expect(existsSync(worktreePath)).toBe(true);
      const list = await execa("git", ["-C", repoDir, "worktree", "list"]);
      expect(list.stdout).toContain("still-registered-wt");
    });

    it("deregistered + already-empty residual directory: removes it and resolves, without needing --force", async () => {
      const { recoverFromWorktreeRemovalFailure } = await import("../../src/commands/cleanup.js");

      const worktreePath = join(harnessHomeDir, "orphaned-empty-wt");
      await mkdir(join(worktreePath, "nested"), { recursive: true }); // dirs only, zero files
      // Never registered as a worktree at all -- isRegisteredWorktree
      // correctly reports false without any Git bookkeeping to remove.

      await expect(
        recoverFromWorktreeRemovalFailure(repoDir, worktreePath, false, new Error("boom")),
      ).resolves.toBeUndefined();

      expect(existsSync(worktreePath)).toBe(false);
    });

    it("deregistered + residual directory still has files, no --force: refuses and preserves the directory", async () => {
      const { recoverFromWorktreeRemovalFailure } = await import("../../src/commands/cleanup.js");
      const { CeError } = await import("../../src/core/errors.js");

      const worktreePath = join(harnessHomeDir, "orphaned-with-files-wt");
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, "real-work.txt"), "uncommitted work\n", "utf8");

      await expect(
        recoverFromWorktreeRemovalFailure(repoDir, worktreePath, false, new Error("boom")),
      ).rejects.toThrow(CeError);

      expect(existsSync(join(worktreePath, "real-work.txt"))).toBe(true);
      expect(await readFile(join(worktreePath, "real-work.txt"), "utf8")).toBe("uncommitted work\n");
    });

    it("deregistered + residual directory still has files, WITH --force: removes it and resolves", async () => {
      const { recoverFromWorktreeRemovalFailure } = await import("../../src/commands/cleanup.js");

      const worktreePath = join(harnessHomeDir, "orphaned-with-files-forced-wt");
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, "leftover.txt"), "leftover\n", "utf8");

      await expect(
        recoverFromWorktreeRemovalFailure(repoDir, worktreePath, true, new Error("boom")),
      ).resolves.toBeUndefined();

      expect(existsSync(worktreePath)).toBe(false);
    });

    it("end-to-end: cleanup preserves branch/workspace/active-pointer when the residual directory has files, then finishes cleanly with --force", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace, readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      // Simulate exactly the partial-removal state this feature
      // recovers from: Git's own worktree bookkeeping is gone (matching
      // the real incident precisely -- deleting `.git/worktrees/<name>`
      // is what a failed `git worktree remove --force` itself left
      // behind), but the directory and a real file inside it survive.
      await deregisterWorktreeBookkeeping(repoDir, workspace.worktreePath);
      await writeFile(join(workspace.worktreePath, "possibly-real-work.txt"), "?\n", "utf8");

      await expect(cleanupCommand({})).rejects.toThrow(/no longer registers/i);

      // Refused safely: everything ce-harness owns is still intact.
      expect(existsSync(workspace.worktreePath)).toBe(true);
      expect(existsSync(join(workspace.worktreePath, "possibly-real-work.txt"))).toBe(true);
      expect(existsSync(workspace.workspacePath)).toBe(true);
      expect(await readActivePointer()).toEqual({ project: basenameOf(repoDir), sanitizedIssue: "issue-1" });

      // Re-running with --force finishes the job completely.
      await expect(cleanupCommand({ force: true })).resolves.toBeUndefined();
      expect(existsSync(workspace.worktreePath)).toBe(false);
      expect(existsSync(workspace.workspacePath)).toBe(false);
      expect(await readActivePointer()).toBeNull();
      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout.trim()).toBe("");
    });

    it("end-to-end: an already-empty orphaned directory (no files at all) finishes cleanup completely, without needing --force", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace, readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      // Deregister, but this time leave nothing of value behind at all
      // (not even the repository's own tracked README.md) -- mirrors
      // the exact real-world recovery: a partially-successful `git
      // worktree remove` had already deleted everything except one
      // stubborn, now-empty directory by the time Git's own bookkeeping
      // disappeared.
      await deregisterWorktreeBookkeeping(repoDir, workspace.worktreePath);
      const remainingEntries = await readdir(workspace.worktreePath);
      await Promise.all(
        remainingEntries.map((entry) => rm(join(workspace.worktreePath, entry), { recursive: true, force: true })),
      );

      await expect(cleanupCommand({})).resolves.toBeUndefined();

      expect(existsSync(workspace.worktreePath)).toBe(false);
      expect(existsSync(workspace.workspacePath)).toBe(false);
      expect(await readActivePointer()).toBeNull();
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
