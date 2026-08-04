import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { createTempRepo, makeDirty } from "../helpers/tempRepo.js";
import {
  nonExistentOpenSpecBin,
  setupFakeOpenSpec,
  teardownFakeOpenSpec,
  type FakeOpenSpecEnv,
} from "../helpers/fakeOpenSpec.js";
import {
  nonExistentOpenCodeBin,
  setupFakeOpenCode,
  teardownFakeOpenCode,
  type FakeOpenCodeEnv,
} from "../helpers/fakeOpenCode.js";

describe("ce start (integration)", () => {
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
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    process.exitCode = originalExitCode;
    await teardownFakeOpenSpec(fakeOpenSpec);
    await teardownFakeOpenCode(fakeOpenCode);
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("creates a worktree, branch, and workspace file for a clean repo", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "Fix Bug #42" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "fix-bug-42");
    const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "fix-bug-42");

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(workspacePath, "workspace.yml"))).toBe(true);

    const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/fix-bug-42"]);
    expect(branches.stdout).toContain("ce-harness/fix-bug-42");

    const { readActivePointer } = await import("../../src/core/workspace.js");
    const pointer = await readActivePointer();
    expect(pointer).toEqual({ project: basenameOf(repoDir), sanitizedIssue: "fix-bug-42" });
  });

  it("creates and registers an external OpenSpec store, and persists its metadata", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const { readWorkspace } = await import("../../src/core/workspace.js");
    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

    expect(workspace.openSpec).toBeDefined();
    expect(workspace.openSpec?.storeId).toMatch(/^ce-/);
    expect(workspace.openSpec?.root).toBe(join(workspace.workspacePath, "openspec"));
    expect(existsSync(workspace.openSpec!.root)).toBe(true);

    const registry = JSON.parse(await (await import("node:fs/promises")).readFile(
      fakeOpenSpec.registryFile,
      "utf8",
    ));
    expect(registry[workspace.openSpec!.storeId].root).toBe(workspace.openSpec!.root);
  });

  it("never creates OpenSpec files in the target repository or the temporary worktree", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    expect(existsSync(join(worktreePath, "openspec"))).toBe(false);
    expect(existsSync(join(repoDir, "openspec"))).toBe(false);
    expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
  });

  it("prints the OpenSpec store id in the success output", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/OpenSpec store: ce-/);
  });

  it("refuses to start when the source repository has uncommitted changes", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    await makeDirty(repoDir);

    await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
      /uncommitted or untracked changes/i,
    );
  });

  it("refuses to overwrite an existing active workspace", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    await expect(startCommand({ repo: repoDir, issue: "issue-2" })).rejects.toThrow(
      /already active/i,
    );
  });

  it("fails with an actionable error when neither main nor master exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ce-harness-nobranch-"));
    try {
      await execa("git", ["init", "--initial-branch=trunk", dir]);
      await execa("git", ["-C", dir, "config", "user.email", "test@example.com"]);
      await execa("git", ["-C", dir, "config", "user.name", "Test User"]);
      await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"]);

      const { startCommand } = await import("../../src/commands/start.js");
      await expect(startCommand({ repo: dir, issue: "issue-1" })).rejects.toThrow(
        /neither "main" nor "master"/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("OpenSpec integration", () => {
    it("fails cleanly, before creating any persistent resource, when openspec is unavailable", async () => {
      process.env.CE_OPENSPEC_BIN = nonExistentOpenSpecBin(fakeOpenSpec.dir);
      const { startCommand } = await import("../../src/commands/start.js");

      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
        /openspec.*not installed|could not be run/i,
      );

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(worktreePath)).toBe(false);
      expect(existsSync(workspacePath)).toBe(false);

      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).toBeNull();
    });

    it("rolls back the worktree, branch, and workspace when store setup fails", async () => {
      process.env.FAKE_OPENSPEC_FAIL_SETUP = "1";
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
        /failed to create and register openspec store/i,
      );

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(worktreePath)).toBe(false);
      expect(existsSync(workspacePath)).toBe(false);

      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout.trim()).toBe("");

      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).toBeNull();
    });

    it("rolls back the created store, worktree, branch, and workspace when doctor reports unhealthy", async () => {
      process.env.FAKE_OPENSPEC_FAIL_DOCTOR = "1";
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
        /failed its health check/i,
      );

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(worktreePath)).toBe(false);
      expect(existsSync(workspacePath)).toBe(false);

      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).toBeNull();

      // The store must have been unregistered as part of rollback.
      const { readFile } = await import("node:fs/promises");
      const registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(Object.keys(registry)).toHaveLength(0);
    });

    it("refuses to start when the generated store id is already registered, without adopting it", async () => {
      const { generateStoreId } = await import("../../src/core/openspecId.js");
      const { resolveRepoRoot } = await import("../../src/core/git.js");
      const { deriveProjectName, sanitizeIssue } = await import("../../src/core/sanitize.js");
      const { setupStore } = await import("../../src/core/openspec.js");
      const { realpath } = await import("node:fs/promises");

      const repoRoot = await resolveRepoRoot(await realpath(repoDir));
      const project = deriveProjectName(repoRoot);
      const sanitizedIssue = sanitizeIssue("issue-1");
      const storeId = generateStoreId(project, sanitizedIssue, repoRoot);

      // Pre-register a store under the exact id ce-harness would generate,
      // simulating a stale/leftover registration from a previous run.
      const preExistingRoot = join(fakeOpenSpec.dir, "pre-existing-store");
      await setupStore(fakeOpenSpec.dir, storeId, preExistingRoot);

      const { startCommand } = await import("../../src/commands/start.js");
      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
        /already registered/i,
      );

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(worktreePath)).toBe(false);
      expect(existsSync(workspacePath)).toBe(false);

      // The pre-existing store must be untouched (not adopted/overwritten).
      const { readFile } = await import("node:fs/promises");
      const registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(registry[storeId].root).toBe(preExistingRoot);
    });
  });

  describe("OpenCode launch", () => {
    it("launches OpenCode in the worktree with no arguments and the expected injected environment", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "Fix Bug #42" });

      const workspace = await readWorkspace(basenameOf(repoDir), "fix-bug-42");
      const { readFile } = await import("node:fs/promises");
      const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "fix-bug-42");
      expect(launch.cwd).toBe(await (await import("node:fs/promises")).realpath(worktreePath));
      expect(launch.argv).toEqual([]);
      expect(launch.env).toEqual({
        CE_WORKSPACE: workspace.workspacePath,
        CE_WORKTREE: workspace.worktreePath,
        CE_PROJECT: workspace.project,
        CE_ISSUE: "Fix Bug #42",
        CE_OPENSPEC_STORE: workspace.openSpec!.storeId,
      });
    });

    it("propagates OpenCode's exit code as ce's own exit code", async () => {
      process.env.FAKE_OPENCODE_EXIT_CODE = "3";
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      expect(process.exitCode).toBe(3);
    });

    it("exits 0 (unset) when OpenCode exits normally with code 0", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      expect(process.exitCode).toBe(0);
    });

    it("does not roll back the workspace when OpenCode cannot be launched, and prints a recovery command", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      // Only break the OpenCode binary once the workspace is otherwise
      // fully set up: point it at a nonexistent path just before start.
      process.env.CE_OPENCODE_BIN = nonExistentOpenCodeBin(fakeOpenCode.dir);

      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
        /failed to launch opencode/i,
      );

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(worktreePath)).toBe(true);
      expect(existsSync(join(workspacePath, "workspace.yml"))).toBe(true);
      expect(await readActivePointer()).toEqual({
        project: basenameOf(repoDir),
        sanitizedIssue: "issue-1",
      });

      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout).toContain("ce-harness/issue-1");
    });

    it("includes an actionable recovery command reproducing the exact launch when OpenCode cannot be launched", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      process.env.CE_OPENCODE_BIN = nonExistentOpenCodeBin(fakeOpenCode.dir);

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      try {
        await startCommand({ repo: repoDir, issue: "issue-1" });
        expect.fail("expected startCommand to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CeError);
        const recovery = (error as InstanceType<typeof CeError>).recovery ?? "";
        expect(recovery).toContain(worktreePath);
        expect(recovery).toContain("CE_WORKSPACE=");
        expect(recovery).toContain("CE_OPENSPEC_STORE=");
      }
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
