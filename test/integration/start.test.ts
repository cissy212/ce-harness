import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { createBareRemote, cloneRepo, createTempRepo, makeDirty } from "../helpers/tempRepo.js";
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
import { nonExistentCodeGraphBin } from "../helpers/fakeCodeGraph.js";

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
    // Deterministic regardless of whether this machine happens to have
    // the real `codegraph` on PATH -- CodeGraph behavior itself is
    // covered by test/integration/codeGraph.test.ts.
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
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
    delete process.env.CE_CODEGRAPH_BIN;
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

  it("the active-workspace error is actionable: names the active project/issue and suggests ce status / ce cleanup", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { CeError } = await import("../../src/core/errors.js");

    await startCommand({ repo: repoDir, issue: "issue-1" });

    try {
      await startCommand({ repo: repoDir, issue: "issue-2" });
      expect.fail("expected startCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/Active workspace:/);
      expect(ceError.message).toMatch(new RegExp(`Project:\\s+${basenameOf(repoDir)}`));
      expect(ceError.message).toMatch(/Issue:\s+issue-1/);
      expect(ceError.recovery).toMatch(/ce status/);
      expect(ceError.recovery).toMatch(/ce cleanup/);
      expect(ceError.recovery).toMatch(/retry `ce start`/i);
    }
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

  describe('Repository-aware base branch detection (never assumes "main")', () => {
    it('a repository whose remote defaults to "develop" creates the worktree from develop, not main', async () => {
      const remoteDir = await createBareRemote("develop");
      const developRepoDir = await cloneRepo(remoteDir);
      try {
        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: developRepoDir, issue: "issue-1" });

        const workspace = await readWorkspace(basenameOf(developRepoDir), "issue-1");
        expect(workspace.baseBranch).toBe("develop");
        expect(workspace.baseBranchCommit).toMatch(/^[0-9a-f]{40}$/);

        const developSha = (
          await execa("git", ["-C", developRepoDir, "rev-parse", "develop"])
        ).stdout.trim();
        expect(workspace.baseBranchCommit).toBe(developSha);

        const worktreeHead = (
          await execa("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"])
        ).stdout.trim();
        expect(worktreeHead).toBe(developSha);

        // No "main" branch exists anywhere in this repository -- confirms
        // the worktree genuinely came from "develop", not a coincidental main.
        const branches = (await execa("git", ["-C", developRepoDir, "branch", "--list"])).stdout;
        expect(branches).not.toMatch(/\bmain\b/);
      } finally {
        await rm(remoteDir, { recursive: true, force: true });
        await rm(developRepoDir, { recursive: true, force: true });
      }
    });

    it("a repository whose remote defaults to main continues to work unchanged", async () => {
      const remoteDir = await createBareRemote("main");
      const cloneDir = await cloneRepo(remoteDir);
      try {
        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: cloneDir, issue: "issue-1" });

        const workspace = await readWorkspace(basenameOf(cloneDir), "issue-1");
        expect(workspace.baseBranch).toBe("main");
        expect(workspace.baseBranchCommit).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        await rm(remoteDir, { recursive: true, force: true });
        await rm(cloneDir, { recursive: true, force: true });
      }
    });

    it("records the resolved base branch and its exact commit for a local-only repository too (no remote at all)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.baseBranch).toBe("main");
      const mainSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      expect(workspace.baseBranchCommit).toBe(mainSha);
    });

    it('shows "Base branch" and "Base commit" in `ce status` for the default flow', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      logSpy.mockClear();

      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Base branch:\s+main/);
      expect(output).toMatch(/Base commit:\s+[0-9a-f]{40}/);
    });

    it("does not record baseBranchCommit for an explicit --base/--head workspace (already captured by diffBase/diffHead)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: "main" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.baseBranchCommit).toBeUndefined();
      expect(workspace.diffBase).toBe(baseSha);
    });

    it("fails with an actionable error, before creating any persistent resource, when the remote's default branch is not resolvable locally", async () => {
      const remoteDir = await createBareRemote("develop");
      const cloneDir = await cloneRepo(remoteDir);
      try {
        // The remote's default branch changes after the clone, and the
        // user never fetches the new branch -- ce-harness must refuse
        // rather than silently falling back to some other branch.
        await execa("git", ["-C", remoteDir, "branch", "main"]);
        await execa("git", ["-C", remoteDir, "symbolic-ref", "HEAD", "refs/heads/main"]);

        const { startCommand } = await import("../../src/commands/start.js");
        const { readActivePointer } = await import("../../src/core/workspace.js");

        await expect(startCommand({ repo: cloneDir, issue: "issue-1" })).rejects.toThrow(
          /reports "main" as its default branch/,
        );

        expect(await readActivePointer()).toBeNull();
        expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
        expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
      } finally {
        await rm(remoteDir, { recursive: true, force: true });
        await rm(cloneDir, { recursive: true, force: true });
      }
    });
  });

  describe("Configurable branch naming", () => {
    it('defaults to "ce-harness/{issue}" -- existing behavior unchanged -- when nothing is configured', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.internalBranch).toBe("ce-harness/issue-1");

      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout).toContain("ce-harness/issue-1");
    });

    it.each([
      ["feature/{issue}", "feature/issue-1"],
      ["bugfix/{issue}", "bugfix/issue-1"],
      ["review/{issue}", "review/issue-1"],
      ["{issue}", "issue-1"],
    ])(
      'uses the repository-configured pattern "%s" -> "%s" for the internal branch',
      async (pattern, expectedBranch) => {
        await execa("git", [
          "-C",
          repoDir,
          "config",
          "ce-harness.branch-pattern",
          pattern,
        ]);

        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: repoDir, issue: "issue-1" });

        const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
        expect(workspace.internalBranch).toBe(expectedBranch);

        const branches = await execa("git", [
          "-C",
          repoDir,
          "branch",
          "--list",
          expectedBranch,
        ]);
        expect(branches.stdout).toContain(expectedBranch);
      },
    );

    it("fails clearly, before creating any persistent resource, when the configured pattern has no {issue} placeholder", async () => {
      await execa("git", ["-C", repoDir, "config", "ce-harness.branch-pattern", "ce-harness"]);

      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
        /does not include the "\{issue\}" placeholder/,
      );

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
    });

    it("does not affect the resolved base branch, worktree location, or any other workspace field", async () => {
      await execa("git", ["-C", repoDir, "config", "ce-harness.branch-pattern", "feature/{issue}"]);

      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.internalBranch).toBe("feature/issue-1");
      expect(workspace.baseBranch).toBe("main");
      expect(workspace.worktreePath).toBe(
        join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1"),
      );
    });

    it("a globally-configured pattern (git config --global) applies too, via Git's own resolution", async () => {
      const globalConfigDir = await mkdtemp(join(tmpdir(), "ce-harness-gitconfig-"));
      const globalConfigFile = join(globalConfigDir, ".gitconfig");
      const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
      // GIT_CONFIG_GLOBAL alone redirects every `git config --global`
      // read/write to this temp file -- never the real developer
      // machine's ~/.gitconfig.
      process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
      try {
        await execa("git", ["config", "--global", "ce-harness.branch-pattern", "review/{issue}"]);

        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: repoDir, issue: "issue-1" });

        const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
        expect(workspace.internalBranch).toBe("review/issue-1");
      } finally {
        if (originalGitConfigGlobal === undefined) {
          delete process.env.GIT_CONFIG_GLOBAL;
        } else {
          process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
        }
        await rm(globalConfigDir, { recursive: true, force: true });
      }
    });

    it("a repository-local override takes precedence over a global default", async () => {
      const globalConfigDir = await mkdtemp(join(tmpdir(), "ce-harness-gitconfig-"));
      const globalConfigFile = join(globalConfigDir, ".gitconfig");
      const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
      try {
        await execa("git", ["config", "--global", "ce-harness.branch-pattern", "review/{issue}"]);
        await execa("git", ["-C", repoDir, "config", "ce-harness.branch-pattern", "bugfix/{issue}"]);

        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: repoDir, issue: "issue-1" });

        const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
        expect(workspace.internalBranch).toBe("bugfix/issue-1");
      } finally {
        if (originalGitConfigGlobal === undefined) {
          delete process.env.GIT_CONFIG_GLOBAL;
        } else {
          process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
        }
        await rm(globalConfigDir, { recursive: true, force: true });
      }
    });
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
        CE_LENSES_DIR: join(workspace.workspacePath, "lenses"),
        CE_DIFF_BASE: null,
        CE_DIFF_HEAD: null,
        // CodeGraph is forced unavailable for this suite (see beforeEach);
        // its availability/env-injection behavior is covered in
        // test/integration/codeGraph.test.ts.
        CE_CODE_NAV_AVAILABLE: null,
        CE_CODE_NAV_PROVIDER: null,
        OPENCODE_CONFIG_DIR: join(workspace.workspacePath, "opencode"),
        OPENCODE_CONFIG: null,
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

  describe("OpenCode external configuration", () => {
    it("creates <workspace>/opencode/{commands,skills,agents,prompts} and points OPENCODE_CONFIG_DIR at it", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const configDir = join(workspace.workspacePath, "opencode");

      expect(existsSync(configDir)).toBe(true);
      expect(existsSync(join(configDir, "commands"))).toBe(true);
      expect(existsSync(join(configDir, "skills"))).toBe(true);
      expect(existsSync(join(configDir, "agents"))).toBe(true);
      expect(existsSync(join(configDir, "prompts"))).toBe(true);

      const { readFile } = await import("node:fs/promises");
      const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
      expect(launch.env.OPENCODE_CONFIG_DIR).toBe(configDir);
    });

    it("never creates .opencode, or any commands/skills/agents/prompts directories, in the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

      for (const dir of [".opencode", "commands", "skills", "agents", "prompts", "opencode"]) {
        expect(existsSync(join(repoDir, dir))).toBe(false);
        expect(existsSync(join(worktreePath, dir))).toBe(false);
      }
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("Lens directory (canonical, runner-agnostic)", () => {
    it("creates <workspace>/lenses as a sibling of opencode/, and injects CE_LENSES_DIR", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const lensesDir = join(workspace.workspacePath, "lenses");

      expect(existsSync(lensesDir)).toBe(true);
      expect(existsSync(join(workspace.workspacePath, "opencode"))).toBe(true);
      // Sibling, never nested inside the OpenCode-specific config dir.
      expect(lensesDir).not.toContain(join("opencode", "agents"));

      const { readFile } = await import("node:fs/promises");
      const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
      expect(launch.env.CE_LENSES_DIR).toBe(lensesDir);
    });

    it("populates <workspace>/lenses from templates/lenses/*.md, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const { readFile } = await import("node:fs/promises");

      for (const filename of [
        "backend-developer.md",
        "pipeline-data-engineer.md",
        "frontend-developer.md",
        "accessibility-reviewer.md",
        "typescript-engineer.md",
        "security-reviewer.md",
      ]) {
        const copiedPath = join(workspace.workspacePath, "lenses", filename);
        const sourcePath = join(templatesRoot(), "lenses", filename);
        expect(existsSync(copiedPath)).toBe(true);
        expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
      }
    });

    it("mirrors the same lens files under opencode/agents/, byte-identical to the canonical copy", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const { readFile } = await import("node:fs/promises");

      for (const filename of [
        "backend-developer.md",
        "pipeline-data-engineer.md",
        "frontend-developer.md",
        "accessibility-reviewer.md",
        "typescript-engineer.md",
        "security-reviewer.md",
      ]) {
        const canonicalPath = join(workspace.workspacePath, "lenses", filename);
        const mirrorPath = join(workspace.workspacePath, "opencode", "agents", filename);
        expect(existsSync(mirrorPath)).toBe(true);
        expect(await readFile(mirrorPath, "utf8")).toBe(await readFile(canonicalPath, "utf8"));
      }
    });

    it("never places the lens directory or its files inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      for (const filename of [
        "lenses",
        "backend-developer.md",
        "pipeline-data-engineer.md",
        "frontend-developer.md",
        "accessibility-reviewer.md",
        "typescript-engineer.md",
        "security-reviewer.md",
      ]) {
        expect(existsSync(join(repoDir, filename))).toBe(false);
        expect(existsSync(join(worktreePath, filename))).toBe(false);
      }
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("Explicit --base/--head review range", () => {
    it("with neither option, default behavior is exactly unchanged: worktree from local main, no diff fields", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.baseBranch).toBe("main");
      expect(workspace.diffBase).toBeUndefined();
      expect(workspace.diffHead).toBeUndefined();
      expect(workspace.diffMergeBase).toBeUndefined();

      const { readFile } = await import("node:fs/promises");
      const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
      expect(launch.env.CE_DIFF_BASE ?? null).toBeNull();
      expect(launch.env.CE_DIFF_HEAD ?? null).toBeNull();
    });

    it("rejects --base without --head before creating any persistent resource", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      await expect(
        startCommand({ repo: repoDir, issue: "issue-1", base: "main" }),
      ).rejects.toThrow(/--base and --head must both be provided together/i);

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
    });

    it("rejects --head without --base before creating any persistent resource", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      await expect(
        startCommand({ repo: repoDir, issue: "issue-1", head: "main" }),
      ).rejects.toThrow(/--base and --head must both be provided together/i);

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
    });

    it("rejects an unresolvable ref before creating any persistent resource", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      await expect(
        startCommand({
          repo: repoDir,
          issue: "issue-1",
          base: "main",
          head: "does-not-exist-anywhere",
        }),
      ).rejects.toThrow(/could not resolve/i);

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
    });

    it("rejects a base/head pair that shares no common history, before creating any persistent resource", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      const headRef = "main";
      const { writeFile } = await import("node:fs/promises");
      await execa("git", ["-C", repoDir, "checkout", "--orphan", "unrelated"]);
      await execa("git", ["-C", repoDir, "rm", "-rf", "."]);
      await writeFile(join(repoDir, "unrelated.txt"), "no shared history\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "unrelated root commit"]);

      await expect(
        startCommand({ repo: repoDir, issue: "issue-1", base: "unrelated", head: headRef }),
      ).rejects.toThrow(/share no common history/i);

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
    });

    it("starts the worktree at the resolved head commit, persists resolved SHAs, and injects CE_DIFF_BASE/CE_DIFF_HEAD", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(repoDir, "feature.txt"), "new feature\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "feature commit"]);
      const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: headSha });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.diffBase).toBe(baseSha);
      expect(workspace.diffHead).toBe(headSha);
      expect(workspace.diffMergeBase).toBe(baseSha);
      expect(workspace.baseBranch).toBe(headSha);

      const worktreeHead = (
        await execa("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"])
      ).stdout.trim();
      expect(worktreeHead).toBe(headSha);

      const { readFile } = await import("node:fs/promises");
      const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
      expect(launch.env.CE_DIFF_BASE).toBe(baseSha);
      expect(launch.env.CE_DIFF_HEAD).toBe(headSha);
    });

    it("accepts short SHAs and branch names as --base/--head and resolves both to full SHAs", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const baseFullSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();

      await startCommand({
        repo: repoDir,
        issue: "issue-1",
        base: baseFullSha.slice(0, 10),
        head: "main",
      });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.diffBase).toBe(baseFullSha);
      expect(workspace.diffBase).toHaveLength(40);
      expect(workspace.diffHead).toBe(baseFullSha);
    });

    it("succeeds when base is not an ancestor of head, as long as they share a merge base (diverged-base case)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { writeFile } = await import("node:fs/promises");

      // Common ancestor is the "initial commit" createTempRepo already made on main.
      const commonAncestor = (
        await execa("git", ["-C", repoDir, "rev-parse", "main"])
      ).stdout.trim();

      // Advance the base side with a commit unrelated to the head change.
      await execa("git", ["-C", repoDir, "checkout", "-b", "diverged-base"]);
      await writeFile(join(repoDir, "base-only.txt"), "base-side change\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "base-only change"]);
      const baseSha = (
        await execa("git", ["-C", repoDir, "rev-parse", "diverged-base"])
      ).stdout.trim();

      // Head diverges from the same common ancestor, not from the base commit.
      await execa("git", ["-C", repoDir, "checkout", "main"]);
      await execa("git", ["-C", repoDir, "checkout", "-b", "diverged-head"]);
      await writeFile(join(repoDir, "head-only.txt"), "head-side change\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "head-only change"]);
      const headSha = (
        await execa("git", ["-C", repoDir, "rev-parse", "diverged-head"])
      ).stdout.trim();

      await execa("git", ["-C", repoDir, "checkout", "main"]);

      // base is NOT an ancestor of head -- this must still succeed.
      const ancestorCheck = await execa(
        "git",
        ["-C", repoDir, "merge-base", "--is-ancestor", baseSha, headSha],
        { reject: false },
      );
      expect(ancestorCheck.exitCode).not.toBe(0);

      await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: headSha });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.diffBase).toBe(baseSha);
      expect(workspace.diffHead).toBe(headSha);
      expect(workspace.diffMergeBase).toBe(commonAncestor);

      // The effective three-dot diff must contain only the head-side
      // change, never the base-side change, even though --base was a
      // real commit with its own (irrelevant) diff.
      const diff = await execa("git", [
        "-C",
        workspace.worktreePath,
        "diff",
        `${baseSha}...${headSha}`,
      ]);
      expect(diff.stdout).toContain("head-only.txt");
      expect(diff.stdout).not.toContain("base-only.txt");
    });

    it("never moves or checks out any branch in the original repository", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { writeFile } = await import("node:fs/promises");

      const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "feature.txt"), "new feature\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "feature commit"]);
      const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      const branchBefore = (
        await execa("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"])
      ).stdout.trim();
      const statusBefore = await execa("git", ["-C", repoDir, "status", "--porcelain"]);

      await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: headSha });

      const branchAfter = (
        await execa("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"])
      ).stdout.trim();
      const statusAfter = await execa("git", ["-C", repoDir, "status", "--porcelain"]);

      expect(branchAfter).toBe(branchBefore);
      expect(branchAfter).toBe("main");
      expect(statusAfter.stdout).toBe(statusBefore.stdout);
      expect(statusAfter.stdout).toBe("");
    });
  });

  describe("Command templates", () => {
    it("copies templates/commands/workspace.md into <workspace>/opencode/commands/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(workspace.workspacePath, "opencode", "commands", "workspace.md");
      const sourcePath = join(templatesRoot(), "commands", "workspace.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("/workspace surfaces the workspace type, derived only from CE_DIFF_BASE/CE_DIFF_HEAD", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "workspace.md"), "utf8");
      const normalized = content.replace(/\s+/g, " ");

      expect(normalized).toMatch(/Workspace type: Implementation/);
      expect(normalized).toMatch(/Workspace type: Existing PR review/);
      expect(normalized).toMatch(/CE_DIFF_BASE.*and.*CE_DIFF_HEAD.*are set/i);
      expect(normalized).toMatch(/Do not derive this from anything else/i);
    });

    it("is generic: additional template files placed in templates/commands/ are copied too, filenames preserved exactly", async () => {
      const originalTemplatesRoot = process.env.CE_TEMPLATES_ROOT;
      const fakeTemplatesRoot = await mkdtemp(join(tmpdir(), "ce-harness-fake-templates-"));
      const { mkdir: mkdirP, writeFile } = await import("node:fs/promises");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdirP(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "workspace.md"), "workspace template\n", "utf8");
      await writeFile(join(commandsDir, "future-command.md"), "future template\n", "utf8");
      process.env.CE_TEMPLATES_ROOT = fakeTemplatesRoot;

      try {
        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: repoDir, issue: "issue-1" });

        const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
        const commandsOut = join(workspace.workspacePath, "opencode", "commands");
        const { readFile, readdir } = await import("node:fs/promises");

        expect((await readdir(commandsOut)).sort()).toEqual(["future-command.md", "workspace.md"]);
        expect(await readFile(join(commandsOut, "workspace.md"), "utf8")).toBe(
          "workspace template\n",
        );
        expect(await readFile(join(commandsOut, "future-command.md"), "utf8")).toBe(
          "future template\n",
        );
      } finally {
        if (originalTemplatesRoot === undefined) {
          delete process.env.CE_TEMPLATES_ROOT;
        } else {
          process.env.CE_TEMPLATES_ROOT = originalTemplatesRoot;
        }
        await rm(fakeTemplatesRoot, { recursive: true, force: true });
      }
    });

    it("never places any copied template file inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "workspace.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "workspace.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("/explore command template", () => {
    it("copies templates/commands/explore.md into <workspace>/opencode/commands/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(workspace.workspacePath, "opencode", "commands", "explore.md");
      const sourcePath = join(templatesRoot(), "commands", "explore.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("references CE_OPENSPEC_STORE", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

      expect(content).toContain("CE_OPENSPEC_STORE");
    });

    it("passes --store \"$CE_OPENSPEC_STORE\" on every documented openspec invocation", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

      // Every fenced-code-block line that invokes the openspec CLI must
      // include --store "$CE_OPENSPEC_STORE".
      const openspecInvocations = content
        .split("\n")
        .filter((line) => /^\s*openspec\s/.test(line));

      expect(openspecInvocations.length).toBeGreaterThan(0);
      for (const line of openspecInvocations) {
        expect(line).toContain('--store "$CE_OPENSPEC_STORE"');
      }
    });

    it("documents the expected openspec subcommands: new change, list, context, instructions, validate", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

      expect(content).toMatch(/openspec new change/);
      expect(content).toMatch(/openspec list/);
      expect(content).toMatch(/openspec context/);
      expect(content).toMatch(/openspec instructions proposal/);
      expect(content).toMatch(/openspec validate/);
    });

    it("explicitly forbids implementing product changes and touching the repository/worktree", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8").then(
        (text) => text.toLowerCase(),
      );

      expect(content).toMatch(/never implement the product change/);
      expect(content).toMatch(/never modify, create, or delete any file inside the target repository/);
      expect(content).toMatch(/never create `openspec\/`, `\.opencode\/`, reports/);
      expect(content).toMatch(/never state a finding.*isn't backed by/);
    });

    it("is generic across repositories (no ce-harness-specific or other project-specific assumptions)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

      expect(content.toLowerCase()).not.toContain("ce-harness");
      expect(content).toMatch(/for any repository/i);
    });

    it("never places explore.md inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "explore.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "explore.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("/propose command template", () => {
    it("copies templates/commands/propose.md into <workspace>/opencode/commands/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(workspace.workspacePath, "opencode", "commands", "propose.md");
      const sourcePath = join(templatesRoot(), "commands", "propose.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("references CE_OPENSPEC_STORE and requires it before proceeding", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toContain("CE_OPENSPEC_STORE");
      expect(content.toLowerCase()).toMatch(/if `ce_openspec_store` is empty or unset, stop/);
    });

    it("passes --store \"$CE_OPENSPEC_STORE\" on every concrete openspec invocation (new change, status, instructions)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      // Only concrete invocations (they include the "<name>" placeholder);
      // excludes prose references like "the `openspec instructions` command".
      const invocations = content
        .split("\n")
        .filter((line) => /openspec (new change|status|instructions).*<name>/.test(line));

      expect(invocations.length).toBeGreaterThanOrEqual(5);
      for (const line of invocations) {
        expect(line).toContain('--store "$CE_OPENSPEC_STORE"');
      }
    });

    it("does not use store discovery / \"if the user names a store\" logic", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      // Checks for the upstream discovery paragraph's distinctive phrasing,
      // not just any mention of "store".
      expect(content).not.toMatch(
        /a store is a standalone openspec repo registered on this machine/i,
      );
      expect(content).not.toMatch(/without a store, commands act on the nearest local/i);
      expect(content).not.toMatch(/openspec store list --json/i);
    });

    it("preserves the upstream artifact dependency loop and applyRequires handling", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      // Artifact ordering / workflow shape preserved from upstream opsx-propose.
      expect(content).toMatch(/proposal\.md \(what & why\)/);
      expect(content).toMatch(/design\.md \(how\)/);
      expect(content).toMatch(/tasks\.md \(implementation steps\)/);
      expect(content).toMatch(/applyRequires/);
      expect(content).toMatch(/TodoWrite tool/);
      expect(content).toMatch(/AskUserQuestion tool/);
      expect(content).toMatch(/resolvedOutputPath/);
      expect(content).toMatch(/Continue until all `applyRequires` artifacts are complete/);
      expect(content).toMatch(/Stop when all `applyRequires` artifacts are done/);
    });

    it("preserves the upstream numbered Steps structure (1-5) unchanged in shape", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(/1\. \*\*If no input provided, ask what they want to build\*\*/);
      expect(content).toMatch(/2\. \*\*Create the change directory\*\*/);
      expect(content).toMatch(/3\. \*\*Get the artifact build order\*\*/);
      expect(content).toMatch(/4\. \*\*Create artifacts in sequence until apply-ready\*\*/);
      expect(content).toMatch(/5\. \*\*Show final status\*\*/);
    });

    it("explicitly forbids product-code changes and repo-local openspec/ or harness artifacts", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8").then(
        (text) => text.toLowerCase(),
      );

      expect(content).toMatch(/never modify product\/application code during `\/propose`/);
      expect(content).toMatch(
        /never create `openspec\/`, `\.opencode\/`, or any other harness\/config file or directory inside the target repository/,
      );
    });

    it("carries no leading HTML comment or trailing provenance essay (provenance lives in THIRD_PARTY_NOTICES.md)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).not.toMatch(/<!--/);
      expect(content).not.toMatch(/_Provenance:/);
      expect(content).not.toMatch(/adapted from OpenSpec/i);
      expect(content).toMatch(/THIRD_PARTY_NOTICES\.md/);
    });

    it("never places propose.md inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "propose.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "propose.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("/apply command template", () => {
    it("copies templates/commands/apply.md into <workspace>/opencode/commands/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(workspace.workspacePath, "opencode", "commands", "apply.md");
      const sourcePath = join(templatesRoot(), "commands", "apply.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("references CE_OPENSPEC_STORE and requires it before proceeding", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).toContain("CE_OPENSPEC_STORE");
      expect(content.toLowerCase()).toMatch(/if `ce_openspec_store` is empty or unset, stop/);
    });

    it("passes --store \"$CE_OPENSPEC_STORE\" on every concrete openspec invocation (list, status, instructions apply)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      // Only concrete invocations (they include --json or --change); excludes
      // the prose provenance reference to "`openspec instructions apply`".
      const invocations = content
        .split("\n")
        .filter((line) => /openspec (list|status|instructions)\b.*(--json|--change)/.test(line));

      expect(invocations.length).toBeGreaterThanOrEqual(3);
      for (const line of invocations) {
        expect(line).toContain('--store "$CE_OPENSPEC_STORE"');
      }
    });

    it("does not use store discovery / \"if the user names a store\" logic", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      // Checks for the upstream discovery paragraph's distinctive phrasing,
      // not just any mention of "store" (which the provenance note itself
      // legitimately discusses).
      expect(content).not.toMatch(
        /a store is a standalone openspec repo registered on this machine/i,
      );
      expect(content).not.toMatch(/without a store, commands act on the nearest local/i);
      expect(content).not.toMatch(/openspec store list --json/i);
    });

    it("preserves the upstream task iteration loop, checkbox updates, blocked state, and completion behavior", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).toMatch(/6\. \*\*Implement tasks \(loop until done or blocked\)\*\*/);
      expect(content).toMatch(/Mark task complete in the tasks file: `- \[ \]` → `- \[x\]`/);
      expect(content).toMatch(/If `state: "blocked"` \(missing artifacts\)/);
      expect(content).toMatch(/If `state: "all_done"`: congratulate, suggest archive/);
      expect(content).toMatch(/Pause if:/);
      expect(content).toMatch(/Task is unclear/);
      expect(content).toMatch(/Error or blocker encountered/);
      expect(content).toMatch(/## Implementation Complete/);
      expect(content).toMatch(/## Implementation Paused/);
      expect(content).toMatch(/contextFiles/);
    });

    it("preserves the upstream numbered Steps structure (1-7) unchanged in shape", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).toMatch(/1\. \*\*Select the change\*\*/);
      expect(content).toMatch(/2\. \*\*Check status to understand the schema\*\*/);
      expect(content).toMatch(/3\. \*\*Get apply instructions\*\*/);
      expect(content).toMatch(/4\. \*\*Read context files\*\*/);
      expect(content).toMatch(/5\. \*\*Show current progress\*\*/);
      expect(content).toMatch(/6\. \*\*Implement tasks \(loop until done or blocked\)\*\*/);
      expect(content).toMatch(/7\. \*\*On completion or pause, show status\*\*/);
    });

    it("limits product-code changes to CE_WORKTREE and keeps CE_REPOSITORY (if set) off-limits", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).toMatch(/only inside `\$CE_WORKTREE`/);
      expect(content.toLowerCase()).toMatch(
        /product-code changes are only allowed inside `\$ce_worktree`/,
      );
      expect(content.toLowerCase()).toMatch(
        /never modify any file under `\$ce_repository` if that variable is set/,
      );
    });

    it("explicitly forbids repo-local openspec/, .opencode/, and harness artifacts in the repository or worktree", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8").then(
        (text) => text.toLowerCase(),
      );

      expect(content).toMatch(
        /never create `openspec\/`, `\.opencode\/`, reports, or any other harness\/config file or directory inside the target repository/,
      );
    });

    it("carries no leading HTML comment or trailing provenance essay (provenance lives in THIRD_PARTY_NOTICES.md)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).not.toMatch(/<!--/);
      expect(content).not.toMatch(/_Provenance:/);
      expect(content).not.toMatch(/adapted from OpenSpec/i);
      expect(content).toMatch(/THIRD_PARTY_NOTICES\.md/);
    });

    it("never places apply.md inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "apply.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "apply.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("/archive command template", () => {
    it("copies templates/commands/archive.md into <workspace>/opencode/commands/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(workspace.workspacePath, "opencode", "commands", "archive.md");
      const sourcePath = join(templatesRoot(), "commands", "archive.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("references CE_OPENSPEC_STORE and requires it before proceeding", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

      expect(content).toContain("CE_OPENSPEC_STORE");
      expect(content.toLowerCase()).toMatch(/if `ce_openspec_store` is empty or unset, stop/);
    });

    it("passes --store \"$CE_OPENSPEC_STORE\" on every concrete openspec invocation (list, status)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

      const invocations = content
        .split("\n")
        .filter((line) => /openspec (list|status)\b.*(--json|--change)/.test(line));

      expect(invocations.length).toBeGreaterThanOrEqual(3);
      for (const line of invocations) {
        expect(line).toContain('--store "$CE_OPENSPEC_STORE"');
      }
    });

    it("does not use store discovery / conditional store-selection logic", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

      expect(content).not.toMatch(
        /a store is a standalone openspec repo registered on this machine/i,
      );
      expect(content).not.toMatch(/without a store, commands act on the nearest local/i);
      expect(content).not.toMatch(/openspec store list --json/i);
    });

    it("preserves the upstream completion checks, incomplete-task warnings, sync decision, confirmation, and final summary", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

      expect(content).toMatch(/1\. \*\*If no change name provided, prompt for selection\*\*/);
      expect(content).toMatch(/2\. \*\*Check artifact completion status\*\*/);
      expect(content).toMatch(/3\. \*\*Check task completion status\*\*/);
      expect(content).toMatch(/5\. \*\*Assess delta spec sync state\*\*/);
      expect(content).toMatch(/6\. \*\*Perform the archive\*\*/);
      expect(content).toMatch(/7\. \*\*Display summary\*\*/);
      expect(content).toMatch(/If any artifacts are not `done`:/);
      expect(content).toMatch(/If incomplete tasks found:/);
      expect(content).toMatch(/Sync now \(recommended\)/);
      expect(content).toMatch(/Archive without syncing/);
      expect(content).toMatch(/## Archive Complete/);
      expect(content).toMatch(/## Archive Complete \(with warnings\)/);
      expect(content).toMatch(/## Archive Failed/);
    });

    it("checks for unresolved verify/adversarial-review evidence (Step 4), passively and read-only", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");
      const normalized = content.replace(/\s+/g, " ");

      expect(content).toMatch(
        /4\. \*\*Check for unresolved review evidence \(read-only, informational only\)\*\*/,
      );
      expect(normalized).toMatch(
        /This step never runs `\/verify` or `\/adversarial-review` itself, never\s*requires either to have run, and never modifies any report/i,
      );
      expect(normalized).toMatch(
        /This applies only to OpenSpec implementation changes/i,
      );
      expect(content).toMatch(/the most recent `\*-verify\.md` file \(by filename date\)/);
      expect(content).toMatch(/the most recent `\*-adversarial-review\.md` file \(by filename date\)/);
      expect(content).toMatch(/## Overall Verdict/);
      expect(normalized).toMatch(
        /If a verify report exists and its verdict is not exactly `PASS`/i,
      );
      expect(normalized).toMatch(
        /If an adversarial-review report exists and its verdict is `FAIL` or\s*`PASS WITH GAPS`/i,
      );
      expect(normalized).toMatch(/Display a warning identifying the report file and its exact\s*verdict/i);
      expect(normalized).toMatch(/Prompt user for confirmation to continue\.\s*- Proceed if user confirms\./i);
      expect(normalized).toMatch(
        /If no such reports exist, or every report found shows a clean\s*`PASS` verdict.*proceed without a warning -- archive behavior is\s*unchanged/i,
      );
    });

    it("never reruns verification and never blocks archive on unresolved review evidence", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");
      const normalized = content.replace(/\s+/g, " ");

      expect(normalized).toMatch(
        /it archives based on artifact\/task completion, plus a passive, read-only surfacing of unresolved evidence/i,
      );
      expect(normalized).toMatch(
        /It never reruns `\/verify` or `\/adversarial-review`, never\s*modifies a report, and never blocks archiving on their findings/i,
      );
    });

    it("includes unresolved review evidence as a possible Warnings entry in the output template", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");
      const normalized = content.replace(/\s+/g, " ");

      expect(content).toMatch(/- Unresolved review evidence: <report filename> \(<verdict>\)/);
      expect(normalized).toMatch(
        /only when at least one holds \(incomplete\s*artifacts, incomplete tasks, a skipped sync, or unresolved review\s*evidence from Step 4\)/i,
      );
    });

    it("resolves archive paths from OpenSpec JSON output, never hardcoded repo-local paths", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

      // The raw mkdir/mv preserved from upstream must operate on
      // JSON-resolved placeholders, not a literal "openspec/changes/..." path.
      expect(content).toMatch(/mkdir -p "<planningHome\.changesDir>\/archive"/);
      expect(content).toMatch(
        /mv "<changeRoot>" "<planningHome\.changesDir>\/archive\/YYYY-MM-DD-<name>"/,
      );
      expect(content).not.toMatch(/mkdir -p "openspec\/changes/);
      expect(content).not.toMatch(/mv "openspec\/changes/);
      // The delta-spec main-spec comparison path is explicitly store-rooted.
      expect(content).toMatch(/<planningHome\.root>\/openspec\/specs\/<capability>\/spec\.md/);
    });

    it("explicitly forbids product-code modification and repo-local openspec/ or harness artifacts", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8").then(
        (text) => text.toLowerCase(),
      );

      expect(content).toMatch(/never modify product\/application code during `\/archive`/);
      expect(content).toMatch(
        /never create `openspec\/`, `\.opencode\/`, reports, or any other harness\/config file or directory inside the target repository/,
      );
      expect(content).toMatch(/never assume repo-local `openspec\/` paths/);
    });

    it("carries no leading HTML comment or trailing provenance essay (provenance lives in THIRD_PARTY_NOTICES.md)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

      expect(content).not.toMatch(/<!--/);
      expect(content).not.toMatch(/_Provenance:/);
      expect(content).not.toMatch(/adapted from OpenSpec/i);
      expect(content).toMatch(/THIRD_PARTY_NOTICES\.md/);
    });

    it("never places archive.md inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "archive.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "archive.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("openspec-sync-specs skill", () => {
    it("recursively copies templates/skills/openspec-sync-specs/SKILL.md into <workspace>/opencode/skills/openspec-sync-specs/SKILL.md, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(
        workspace.workspacePath,
        "opencode",
        "skills",
        "openspec-sync-specs",
        "SKILL.md",
      );
      const sourcePath = join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("references CE_OPENSPEC_STORE and requires it before proceeding", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(
        join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md"),
        "utf8",
      );

      expect(content).toContain("CE_OPENSPEC_STORE");
      expect(content.toLowerCase()).toMatch(/if `ce_openspec_store` is empty or unset, stop/);
    });

    it("passes --store \"$CE_OPENSPEC_STORE\" on every concrete openspec invocation (list, status)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(
        join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md"),
        "utf8",
      );

      const invocations = content
        .split("\n")
        .filter((line) => /openspec (list|status)\b.*(--json|--change)/.test(line));

      expect(invocations.length).toBeGreaterThanOrEqual(2);
      for (const line of invocations) {
        expect(line).toContain('--store "$CE_OPENSPEC_STORE"');
      }
    });

    it("does not use store discovery / conditional store-selection logic", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(
        join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md"),
        "utf8",
      );

      expect(content).not.toMatch(
        /a store is a standalone openspec repo registered on this machine/i,
      );
      expect(content).not.toMatch(/without a store, commands act on the nearest local/i);
      expect(content).not.toMatch(/openspec store list --json/i);
    });

    it("preserves the upstream sync workflow: delta-spec discovery, intelligent merging, and summary output", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(
        join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md"),
        "utf8",
      );

      expect(content).toMatch(/1\. \*\*If no change name provided, prompt for selection\*\*/);
      expect(content).toMatch(/2\. \*\*Resolve change context\*\*/);
      expect(content).toMatch(/3\. \*\*Find delta specs\*\*/);
      expect(content).toMatch(/4\. \*\*For each delta spec, apply changes to main specs\*\*/);
      expect(content).toMatch(/5\. \*\*Show summary\*\*/);
      expect(content).toMatch(/## ADDED Requirements/);
      expect(content).toMatch(/## MODIFIED Requirements/);
      expect(content).toMatch(/## REMOVED Requirements/);
      expect(content).toMatch(/## RENAMED Requirements/);
      expect(content).toMatch(/Key Principle: Intelligent Merging/);
      expect(content).toMatch(/## Specs Synced: <change-name>/);
    });

    it("resolves main-spec paths from planningHome.root, never a bare repo-local openspec/ path", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(
        join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md"),
        "utf8",
      );

      const rootedOccurrences = content.match(
        /<planningHome\.root>\/openspec\/specs\/<capability>\/spec\.md/g,
      );
      const anyOccurrences = content.match(/openspec\/specs\/<capability>\/spec\.md/g);

      expect(rootedOccurrences?.length).toBeGreaterThanOrEqual(2);
      // Every occurrence of the main-spec path is the rooted form -- none
      // are a bare, non-rooted "openspec/specs/..." reference.
      expect(anyOccurrences?.length).toBe(rootedOccurrences?.length);
    });

    it("explicitly forbids product-code modification and repo-local openspec/ or harness artifacts", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(
        join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md"),
        "utf8",
      ).then((text) => text.toLowerCase());

      expect(content).toMatch(/never modify product\/application code/);
      expect(content).toMatch(
        /never create `openspec\/`, `\.opencode\/`, or any other harness\/config file or directory inside the target repository/,
      );
      expect(content).toMatch(/never assume repo-local `openspec\/` paths/);
    });

    it("carries no leading HTML comment or trailing provenance essay (provenance lives in THIRD_PARTY_NOTICES.md)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(
        join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md"),
        "utf8",
      );

      expect(content).not.toMatch(/<!--/);
      expect(content).not.toMatch(/_Provenance:/);
      expect(content).not.toMatch(/adapted from OpenSpec/i);
      expect(content).toMatch(/THIRD_PARTY_NOTICES\.md/);
    });

    it("never places the skill inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "openspec-sync-specs"))).toBe(false);
      expect(existsSync(join(repoDir, "SKILL.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "openspec-sync-specs"))).toBe(false);
      expect(existsSync(join(worktreePath, "SKILL.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("composition-patterns skill", () => {
    const RULE_FILENAMES = [
      "architecture-avoid-boolean-props.md",
      "architecture-compound-components.md",
      "patterns-children-over-render-props.md",
      "patterns-explicit-variants.md",
      "react19-no-forwardref.md",
      "state-context-interface.md",
      "state-decouple-implementation.md",
      "state-lift-state.md",
    ];

    it("recursively copies SKILL.md and every rules/*.md file into <workspace>/opencode/skills/composition-patterns/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const { readFile } = await import("node:fs/promises");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedSkillDir = join(
        workspace.workspacePath,
        "opencode",
        "skills",
        "composition-patterns",
      );
      const sourceSkillDir = join(templatesRoot(), "skills", "composition-patterns");

      const copiedSkillMd = join(copiedSkillDir, "SKILL.md");
      const sourceSkillMd = join(sourceSkillDir, "SKILL.md");
      expect(existsSync(copiedSkillMd)).toBe(true);
      expect(await readFile(copiedSkillMd, "utf8")).toBe(await readFile(sourceSkillMd, "utf8"));

      for (const filename of RULE_FILENAMES) {
        const copiedRulePath = join(copiedSkillDir, "rules", filename);
        const sourceRulePath = join(sourceSkillDir, "rules", filename);
        expect(existsSync(copiedRulePath)).toBe(true);
        expect(await readFile(copiedRulePath, "utf8")).toBe(await readFile(sourceRulePath, "utf8"));
      }
    });

    it("includes required name/description/license frontmatter fields", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(
        join(templatesRoot(), "skills", "composition-patterns", "SKILL.md"),
        "utf8",
      );

      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/^name: vercel-composition-patterns$/m);
      expect(content).toMatch(/^description:\s*$/m);
      expect(content).toMatch(/^license: MIT$/m);
    });

    it("carries no runner-specific tool coupling or ce-harness-specific env vars (pure reference content)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const sourceSkillDir = join(templatesRoot(), "skills", "composition-patterns");

      const skillContent = await readFile(join(sourceSkillDir, "SKILL.md"), "utf8");
      for (const filename of RULE_FILENAMES) {
        const ruleContent = await readFile(join(sourceSkillDir, "rules", filename), "utf8");
        expect(ruleContent).not.toMatch(/CE_[A-Z_]+/);
        expect(ruleContent).not.toMatch(/openspec/i);
        expect(ruleContent).not.toMatch(/\$CE_WORKTREE|\$CE_OPENSPEC_STORE/);
      }
      expect(skillContent).not.toMatch(/CE_[A-Z_]+/);
      expect(skillContent).not.toMatch(/openspec/i);
    });

    it("records provenance in THIRD_PARTY_NOTICES.md and carries the standard trailing reference line", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const skillContent = await readFile(
        join(templatesRoot(), "skills", "composition-patterns", "SKILL.md"),
        "utf8",
      );
      expect(skillContent).toMatch(/THIRD_PARTY_NOTICES\.md/);

      const noticesPath = join(templatesRoot(), "..", "THIRD_PARTY_NOTICES.md");
      const notices = await readFile(noticesPath, "utf8");
      expect(notices).toMatch(/templates\/skills\/composition-patterns\/SKILL\.md/);
      expect(notices).toMatch(/vercel-labs\/agent-skills/);
      expect(notices).toMatch(/License: MIT/);
    });

    it("does not vendor upstream authoring/build artifacts not needed at runtime", async () => {
      const sourceSkillDir = join(
        (await import("../../src/core/templates.js")).templatesRoot(),
        "skills",
        "composition-patterns",
      );

      for (const unwanted of [
        "AGENTS.md",
        "README.md",
        "metadata.json",
        join("rules", "_sections.md"),
        join("rules", "_template.md"),
      ]) {
        expect(existsSync(join(sourceSkillDir, unwanted))).toBe(false);
      }
    });

    it("never places the skill inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "composition-patterns"))).toBe(false);
      expect(existsSync(join(worktreePath, "composition-patterns"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });
  });

  describe("/verify command template", () => {
    it("copies templates/commands/verify.md into <workspace>/opencode/commands/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(workspace.workspacePath, "opencode", "commands", "verify.md");
      const sourcePath = join(templatesRoot(), "commands", "verify.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("references CE_OPENSPEC_STORE and CE_WORKTREE and requires both before proceeding", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      expect(content).toContain("CE_OPENSPEC_STORE");
      expect(content).toContain("CE_WORKTREE");
      expect(content.toLowerCase()).toMatch(
        /if `ce_openspec_store` or `ce_worktree` is empty or unset, stop/,
      );
    });

    describe("refuses to run in an existing-PR-review workspace", () => {
      it("checks CE_DIFF_BASE/CE_DIFF_HEAD before the store/worktree guard, and stops entirely", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/^>\s?/gm, "").replace(/\s+/g, " ");

        const reviewGuardIndex = content.search(
          /If `CE_DIFF_BASE` and `CE_DIFF_HEAD` are both set/,
        );
        const storeGuardIndex = content.search(
          /if `CE_OPENSPEC_STORE` or `CE_WORKTREE` is empty or unset, stop/i,
        );
        expect(reviewGuardIndex).toBeGreaterThan(-1);
        expect(storeGuardIndex).toBeGreaterThan(-1);
        expect(reviewGuardIndex).toBeLessThan(storeGuardIndex);

        expect(normalized).toMatch(/Do not attempt any partial verification/i);
        expect(normalized).toMatch(/Stop entirely and take no further action/i);
      });

      it("explains this workspace reviews an existing commit range, not an OpenSpec implementation", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/^>\s?/gm, "").replace(/\s+/g, " ");

        expect(normalized).toMatch(/reviewing an existing commit range/i);
        expect(normalized).toMatch(
          /`\/verify` checks conformance against the artifacts of an OpenSpec change/i,
        );
        expect(normalized).toMatch(/auxiliary OpenSpec change this workspace generated/i);
      });

      it("points the user at /adversarial-review as the correct command", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/^>\s?/gm, "").replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`\/adversarial-review` is the correct command for reviewing an external commit range/i,
        );
      });
    });

    it("passes --store \"$CE_OPENSPEC_STORE\" on every concrete openspec invocation (list, status)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      const invocations = content
        .split("\n")
        .filter((line) => /^openspec (list|status)\b.*(--json|--change)/.test(line));

      expect(invocations.length).toBeGreaterThanOrEqual(2);
      for (const line of invocations) {
        expect(line).toContain('--store "$CE_OPENSPEC_STORE"');
      }
    });

    it("does not assume any repo-local openspec/ path, resolving changeRoot/artifactPaths from JSON instead", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      expect(content).toMatch(/changeRoot/);
      expect(content).toMatch(/artifactPaths/);
      expect(content).not.toMatch(/openspec\/changes\//);
      expect(content).not.toMatch(/openspec\/config\.yaml/);
    });

    it("resolves the report path from changeRoot, writing only under <changeRoot>/reports/", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      expect(content).toMatch(/mkdir -p "<changeRoot>\/reports"/);
      expect(content).toMatch(/<changeRoot>\/reports\/<YYYY-MM-DD>-verify\.md/);
    });

    describe("explicit CE_DIFF_BASE/CE_DIFF_HEAD review range", () => {
      it("uses three-dot diff semantics on the explicit range when both are present, and skips base-branch detection", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).toContain("CE_DIFF_BASE");
        expect(content).toContain("CE_DIFF_HEAD");
        expect(content).toMatch(/git -C "\$CE_WORKTREE" diff "\$CE_DIFF_BASE\.\.\.\$CE_DIFF_HEAD"/);
        // Two-dot for the commit log only, never for the diff itself.
        expect(content).toMatch(/git -C "\$CE_WORKTREE" log --oneline "\$CE_DIFF_BASE\.\.\$CE_DIFF_HEAD"/);
        expect(content).not.toMatch(/diff "\$CE_DIFF_BASE" "\$CE_DIFF_HEAD"/);
      });

      it("preserves the merge-base fallback for when CE_DIFF_BASE/CE_DIFF_HEAD are absent", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).toMatch(/merge-base HEAD main/);
        expect(content).toMatch(/merge-base HEAD master/);
        expect(content).toMatch(/Otherwise, find a base for a proper diff/i);
      });
    });

    it("forbids product-code edits and task-checkbox updates", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8").then(
        (text) => text.toLowerCase(),
      );

      expect(content).toMatch(/never modify product\/application code/);
      expect(content).toMatch(/never check, uncheck, or otherwise edit `tasks\.md`/);
    });

    it("does not hardcode stack-specific verification commands", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      expect(content).not.toMatch(/npm test/);
      expect(content).not.toMatch(/npm run (typecheck|lint)/);
      // "Prisma" legitimately appears as an example of a stack this command
      // must NOT assume for verification-command discovery (requirement 7's
      // own wording), and separately as an illustrative example of a
      // *mutating* command in the Environment-mutation safety guardrails
      // (`prisma migrate deploy`) -- it must never appear as an actual
      // invoked/discovered command (e.g. "npx prisma ..." or inside a
      // fenced shell block this command itself runs).
      expect(content).not.toMatch(/npx prisma/i);
      expect(content).not.toMatch(/```bash\n[^`]*prisma migrate/i);
      // "docker compose" legitimately appears only within the Docker
      // safety guardrails, as an illustrative example of what to check
      // *if* a discovered verification command happens to use it --
      // never as part of the discovery instructions themselves (i.e.
      // never presented as an assumed or hardcoded default).
      const dockerSafetyIdx = content.indexOf("### Docker safety");
      expect(dockerSafetyIdx).toBeGreaterThan(-1);
      expect(content.slice(0, dockerSafetyIdx)).not.toMatch(/docker compose/i);
      expect(content).toMatch(/discovered from the repository/i);
      expect(content).toMatch(/do not assume npm, docker, prisma, or any other specific stack/i);
    });

    it("includes all four evidence categories and the three-way overall verdict", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      expect(content).toMatch(/VERIFIED/);
      expect(content).toMatch(/PARTIALLY VERIFIED/);
      expect(content).toMatch(/NOT VERIFIED/);
      expect(content).toMatch(/BLOCKED/);
      expect(content).toMatch(/## Overall Verdict/);
      expect(content).toMatch(/PASS WITH GAPS/);
      expect(content).toMatch(/\bFAIL\b/);
    });

    it("includes the required report sections in order", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      const sectionOrder = [
        "## Scope",
        "## Evidence Examined",
        "## Lens Coverage",
        "## Requirement / Scenario Verification",
        "## Design Commitment Verification",
        "## Task Verification",
        "## Commands Executed and Outcomes",
        "## Gaps and Blockers",
        "## Overall Verdict",
      ];
      let searchFrom = 0;
      for (const heading of sectionOrder) {
        const index = content.indexOf(heading, searchFrom);
        expect(index).toBeGreaterThan(-1);
        searchFrom = index + heading.length;
      }
    });

    it("does not implement fixes automatically -- only suggests them in chat after the report is written", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      expect(content).toMatch(/you may \*\*suggest\*\* fixes/i);
      expect(content).toMatch(/never apply them automatically/i);
      expect(content).toMatch(/only verifies and reports/i);
    });

    it("carries no leading HTML comment or trailing provenance essay (provenance lives in THIRD_PARTY_NOTICES.md)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      expect(content).not.toMatch(/<!--/);
      expect(content).not.toMatch(/_Provenance:/);
      expect(content).not.toMatch(/market-audit-tool/i);
      expect(content).not.toMatch(/verify-against-spec/i);
      expect(content).toMatch(/THIRD_PARTY_NOTICES\.md/);
    });

    it("never places verify.md inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "verify.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "verify.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });

    describe("Lens selection", () => {
      it("discovers and reads lenses only through $CE_LENSES_DIR, never an OpenCode-specific path", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ").toLowerCase();

        expect(content).toContain('"$CE_LENSES_DIR"');
        expect(content).not.toMatch(/CE_SPECIALISTS_DIR/);
        // "opencode/agents" may be mentioned only as a forbidden example
        // ("never hardcode ... such as `opencode/agents/`"), never as an
        // actual directory this command lists or reads lenses from.
        const segments = normalized.split("opencode/agents");
        expect(segments.length - 1).toBeGreaterThan(0);
        for (let i = 0; i < segments.length - 1; i++) {
          const precedingContext = segments[i].slice(-40);
          expect(precedingContext).toMatch(/never hardcode|such as/);
        }
      });

      it("states that ce-harness, not the runner, owns selection, and forbids relying on automatic skill/agent matching", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ").toLowerCase();

        expect(normalized).toMatch(/ce-harness .* owns lens selection/i);
        expect(normalized).toMatch(
          /never rely on the runner's own automatic skill or agent matching/,
        );
      });

      it("gives operational/runtime concerns precedence over structural concerns on overlap", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/operational\/runtime concern.{0,120}take precedence/i);
      });

      it("asks the user when multiple lenses match, and always allows explicit override", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/two or more lenses match.*ask which to apply/i);
        expect(normalized).toMatch(/always allow an? explicit user override/i);
      });

      it("auto-selects without asking when exactly one lens clearly matches", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /If exactly one lens clearly matches, select it and continue -- no need\s*to ask/i,
        );
      });

      it("preserves the presented order when the user says 'all'", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /literal\s*word `all` \(apply every matching lens, in the order they were\s*presented\)/i,
        );
      });

      it('continues normally and reports "Lenses applied: None" when nothing clearly matches', async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).toMatch(/continue normally/i);
        expect(content).toContain("Lenses applied: None");
        expect(content).toMatch(/this is not a failure/i);
      });

      it("loads each selected lens as an ordinary reasoning input, never a subagent or delegated conversation", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/load each one's file as an ordinary reasoning input/i);
        expect(normalized).toMatch(/do not spawn a subagent/i);
      });

      it("states lenses are additive and multiple may be selected without repeating the baseline pass", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/Lenses are additive, not mutually exclusive/i);
        expect(normalized).toMatch(
          /the user may pick one, several, all, or none.*not a single-choice menu/i,
        );
        expect(normalized).toMatch(/literal word `all`/i);
        expect(normalized).toMatch(/literal word `none`/i);
        expect(normalized).toMatch(
          /one progressively richer review, not one review per lens/i,
        );
      });

      it("requires de-duplicating repeated lens names and preserving user-given order", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/De-duplicate repeated names without loading the same lens twice/i);
        expect(normalized).toMatch(/preserve the order the user\s*named them in/i);
      });

      it("explains and re-asks rather than silently dropping an unresolvable lens name", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/do not drop it silently/i);
        expect(normalized).toMatch(
          /explain which name\(s\) could not be resolved, list the valid lens\s*names, and ask again/i,
        );
      });

      it("extends the explicit override to one or more named lenses, validated the same way", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /if the user has already named\s*one or more specific lenses \(or "none"\) before this step runs/i,
        );
      });

      it("includes a '## Lens Coverage' report section with the top-level fields and a per-lens table", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).toMatch(/## Lens Coverage/);
        expect(content).toMatch(/\*\*Lenses applied:\*\*/);
        expect(content).toMatch(/\*\*Other lenses considered:\*\*/);
        expect(content).toMatch(/\| Lens \| Selection rationale \| Lens checks applied \|/);
        expect(content).toMatch(/N\/A -- no lens applied/);
      });

      it('never uses "specialist" terminology anywhere in the operational body', async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).not.toMatch(/specialist/i);
      });
    });

    describe("Environment-mutation safety", () => {
      const readVerify = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
      };

      it("keeps observation (tests, lint, typecheck, build, read-only queries) allowed by default, unchanged", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Observation is allowed by default: tests, lint, typecheck, build,\s*`git status`\/`log`\/`diff`, `docker ps`, schema\/code inspection, and\s*read-only database queries never require approval/i,
        );
      });

      it("does not impose a blanket ban on migrations -- explicitly allows them when part of the change", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /This does \*\*not\*\* mean verification commands may never run a migration\s*-- a migration can be an explicit part of the change being verified/i,
        );
      });

      it("requires approval before mutation that is unrelated to the change (Case A)", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /\*\*Case A -- the mutation is not part of the change being verified\*\*/,
        );
        expect(normalized).toMatch(/tests fail because the local database is out of date/i);
        expect(normalized).toMatch(
          /Do not perform it\s*automatically\. Explain what is required and ask the user for explicit\s*approval first/i,
        );
      });

      it("allows a change-required migration to run without asking only in a proven disposable environment (Case B)", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /\*\*Case B -- the mutation is explicitly part of the OpenSpec change\*\*/,
        );
        expect(normalized).toMatch(/against the proposal, design, specs, and tasks already loaded/i);
        expect(normalized).toMatch(
          /you may exercise the mutation there without asking, provided\s*concrete repo evidence -- not assumption -- shows it cannot affect\s*development\/shared\/production state/i,
        );
        expect(normalized).toMatch(
          /Never infer that an environment\s*is disposable merely because its name contains "test"/i,
        );
      });

      it("requires approval for a change-required mutation against a persistent/shared environment (Case B)", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /If verification would instead mutate an existing persistent or\s*shared environment, ask the user first/i,
        );
      });

      it("requires approval when environment safety cannot be established (Case C)", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /\*\*Case C -- environment safety cannot be established\*\* from concrete\s*repo evidence either way\. Do not mutate it\. Ask\./i,
        );
      });

      it("specifies what the approval prompt must state", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /state: the exact command that would run; the specific\s*environment\/resource it would mutate; why the change requires it; and\s*whether the mutation is reversible or disposable/i,
        );
      });

      it("lists mutating command examples as illustrative, not an exhaustive blacklist, and forbids name-matching alone", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/prisma migrate deploy/);
        expect(normalized).toMatch(/terraform apply/);
        expect(normalized).toMatch(/kubectl apply/);
        expect(normalized).toMatch(
          /These are examples of the category, not an exhaustive blacklist: do not\s*decide "safe" or "unsafe" by matching a command name alone/i,
        );
        expect(normalized).toMatch(
          /do not\s*assume a nominally "test" command is safe merely because of its name --\s*if it performs destructive setup, it is still mutation and the rules\s*below still apply/i,
        );
      });

      it("reports a withheld mutation as BLOCKED, a verification limitation, never as a defect", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /mark the affected check\s*`BLOCKED` \(never `NOT VERIFIED`\) and state the specific limitation under\s*"Gaps and Blockers" -- a withheld mutation is a verification limitation,\s*not an implementation defect/i,
        );
      });

      it("summarizes the policy in the Guardrails section", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Mutating database schema\/data, infrastructure, external services, or\s*developer configuration always requires either a proven disposable\s*environment.*or explicit user approval/i,
        );
      });
    });

    describe("Docker safety", () => {
      const readVerify = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
      };

      it("frames Docker ownership/collision checks as read-only diagnosis that always runs, distinct from the mutation classification", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(content).toMatch(/### Docker safety/);
        expect(normalized).toMatch(
          /This is read-only\s*diagnosis, not mutation -- it always runs, before Environment-mutation\s*safety's Case A\/B\/C classification above even applies to the Docker\s*command itself/i,
        );
      });

      it("requires verifying container ownership via the compose working_dir label before reusing any running container", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/\*\*Container ownership\.\*\* Never reuse an already-running container by\s*name or image alone/i);
        expect(content).toMatch(/com\.docker\.compose\.project\.working_dir/);
        expect(normalized).toMatch(
          /it must resolve to `\$CE_WORKTREE` or a path inside it\. If it\s*resolves anywhere else.*that container does not belong to this\s*workspace: never reuse, stop, remove, or otherwise touch it/i,
        );
      });

      it("requires detecting Compose project-name collisions before running docker compose up, preferring an explicit project name", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/\*\*Compose project-name collisions\.\*\*/);
        expect(normalized).toMatch(/docker compose ls/);
        expect(normalized).toMatch(
          /reuse it only if its `working_dir` label\s*resolves inside `\$CE_WORKTREE`; otherwise this is a genuine\s*collision -- report it, never silently pick a different name or\s*proceed/i,
        );
        expect(normalized).toMatch(
          /Prefer an explicit `--project-name` \(or\s*`COMPOSE_PROJECT_NAME`\) derived deterministically from `\$CE_WORKTREE`/i,
        );
      });

      it("requires checking for port conflicts before startup, never silently picking a different port", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/\*\*Port conflicts\.\*\* Before starting anything, read the compose/i);
        expect(normalized).toMatch(
          /check\s*whether each is already in use.*before\s*attempting startup, not after it fails with a cryptic error/i,
        );
        expect(normalized).toMatch(
          /never\s*a signal to silently pick a different port than the one the\s*repository's own configuration specifies/i,
        );
      });

      it("reports collisions/conflicts as BLOCKED, never a silent work-around, regardless of a repository's specific Docker setup", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /do not start, reuse, or otherwise proceed\. Mark the\s*affected check `BLOCKED`/i,
        );
        expect(normalized).toMatch(
          /None of this is specific to any one repository's\s*Docker\/Compose setup: the same three checks apply regardless of the\s*service names, ports, or project names a given repository happens to\s*define/i,
        );
      });

      it("summarizes the policy in the Guardrails section", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Before interacting with Docker, verify container and Compose-project\s*ownership and check for port conflicts -- see "Docker safety" in\s*Step 8/i,
        );
      });
    });
  });

  describe("/adversarial-review command template", () => {
    const templatePath = () => import("../../src/core/templates.js").then((m) => m.templatesRoot());
    const readTemplate = async () => {
      const { readFile } = await import("node:fs/promises");
      return readFile(join(await templatePath(), "commands", "adversarial-review.md"), "utf8");
    };

    it("copies templates/commands/adversarial-review.md into <workspace>/opencode/commands/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(
        workspace.workspacePath,
        "opencode",
        "commands",
        "adversarial-review.md",
      );
      const sourcePath = join(templatesRoot(), "commands", "adversarial-review.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("references CE_OPENSPEC_STORE and CE_WORKTREE and requires both before proceeding", async () => {
      const content = await readTemplate();

      expect(content).toContain("CE_OPENSPEC_STORE");
      expect(content).toContain("CE_WORKTREE");
      expect(content.toLowerCase()).toMatch(
        /if `ce_openspec_store` or `ce_worktree` is empty or unset, stop/,
      );
    });

    it("passes --store \"$CE_OPENSPEC_STORE\" on every concrete openspec invocation (list, status)", async () => {
      const content = await readTemplate();

      const invocations = content
        .split("\n")
        .filter((line) => /^openspec (list|status)\b.*(--json|--change)/.test(line));

      expect(invocations.length).toBeGreaterThanOrEqual(2);
      for (const line of invocations) {
        expect(line).toContain('--store "$CE_OPENSPEC_STORE"');
      }
    });

    it("does not assume any repo-local openspec/ path, resolving changeRoot/artifactPaths from JSON instead", async () => {
      const content = await readTemplate();

      expect(content).toMatch(/changeRoot/);
      expect(content).toMatch(/artifactPaths/);
      expect(content).not.toMatch(/openspec\/changes\//);
    });

    it("resolves the report path from changeRoot, writing only under <changeRoot>/reports/", async () => {
      const content = await readTemplate();

      expect(content).toMatch(/mkdir -p "<changeRoot>\/reports"/);
      expect(content).toMatch(
        /<changeRoot>\/reports\/<YYYY-MM-DD>-adversarial-review\.md/,
      );
    });

    describe("explicit CE_DIFF_BASE/CE_DIFF_HEAD review range", () => {
      it("uses three-dot diff semantics on the explicit range when both are present, and skips base-branch detection", async () => {
        const content = await readTemplate();

        expect(content).toContain("CE_DIFF_BASE");
        expect(content).toContain("CE_DIFF_HEAD");
        expect(content).toMatch(/git -C "\$CE_WORKTREE" diff "\$CE_DIFF_BASE\.\.\.\$CE_DIFF_HEAD"/);
        expect(content).toMatch(/git -C "\$CE_WORKTREE" log --oneline "\$CE_DIFF_BASE\.\.\$CE_DIFF_HEAD"/);
        expect(content).not.toMatch(/diff "\$CE_DIFF_BASE" "\$CE_DIFF_HEAD"/);
      });

      it("preserves the merge-base fallback for when CE_DIFF_BASE/CE_DIFF_HEAD are absent", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/merge-base HEAD main/);
        expect(content).toMatch(/merge-base HEAD master/);
        expect(content).toMatch(/Otherwise, find a base for a proper diff/i);
      });
    });

    it("includes BLOCKER/MAJOR/MINOR severities and the three-way PASS/PASS WITH GAPS/FAIL verdict", async () => {
      const content = await readTemplate();

      expect(content).toMatch(/\bBLOCKER\b/);
      expect(content).toMatch(/\bMAJOR\b/);
      expect(content).toMatch(/\bMINOR\b/);
      expect(content).toMatch(/## Overall Verdict/);
      expect(content).toMatch(/`PASS`/);
      expect(content).toMatch(/`PASS WITH GAPS`/);
      expect(content).toMatch(/`FAIL`/);
    });

    it("requires evidence, impact, area, confidence, and merge impact for every in-change finding, with a dedicated findings table", async () => {
      const content = await readTemplate();

      expect(content).toMatch(
        /\| Severity \| Confidence \| Merge impact \| Area \| Affected Requirement\/Design\/Task \| Finding \| Evidence \| Impact \| Recommended Fix \|/,
      );
      expect(content).toMatch(/never invent a finding you don't have evidence for/i);
      expect(content).toMatch(
        /state the affected\s*requirement\/design decision\/task, its impact, its\s*Area, its Confidence, its Merge impact, and a recommended fix/i,
      );
    });

    it("forbids product-code edits and task-checkbox updates", async () => {
      const content = await readTemplate().then((text) => text.toLowerCase());

      expect(content).toMatch(/never modify product\/application code/);
      expect(content).toMatch(/never check, uncheck, or otherwise edit `tasks\.md`/);
    });

    it("actively challenges an existing verify report rather than trusting it blindly", async () => {
      const content = await readTemplate();

      expect(content).toMatch(/check for an existing verify report -- and challenge it/i);
      expect(content).toMatch(/do not accept its conclusions at face value/i);
      expect(content).toMatch(/actively look for what it might have\s*missed/i);
      expect(content).toMatch(/Verify Report Challenge/);
      expect(content).toMatch(/if none exists.*note this in the report and proceed to establish your\s*own evidence from scratch/i);
    });

    it("forbids repo-local harness artifacts and requires the report inside the external store only", async () => {
      const content = await readTemplate().then((text) => text.toLowerCase());

      expect(content).toMatch(
        /never create `openspec\/`, `\.opencode\/`, `reports\/`, or any other\s*harness\/config file or directory inside the target repository/,
      );
    });

    it("carries no leading HTML comment or trailing provenance essay (provenance lives in THIRD_PARTY_NOTICES.md)", async () => {
      const content = await readTemplate();

      expect(content).not.toMatch(/<!--\s*(Methodology adapted|Adapted from)/);
      expect(content).not.toMatch(/_Provenance:/);
      expect(content).not.toMatch(/market-audit-tool/i);
      expect(content).not.toMatch(/lidr-specboot/i);
      expect(content).toMatch(/THIRD_PARTY_NOTICES\.md/);
    });

    it("never places adversarial-review.md inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "adversarial-review.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "adversarial-review.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });

    describe("Lens selection", () => {
      it("discovers and reads lenses only through $CE_LENSES_DIR, never an OpenCode-specific path", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ").toLowerCase();

        expect(content).toContain('"$CE_LENSES_DIR"');
        expect(content).not.toMatch(/CE_SPECIALISTS_DIR/);
        // "opencode/agents" may be mentioned only as a forbidden example
        // ("never hardcode ... such as `opencode/agents/`"), never as an
        // actual directory this command lists or reads lenses from.
        const segments = normalized.split("opencode/agents");
        expect(segments.length - 1).toBeGreaterThan(0);
        for (let i = 0; i < segments.length - 1; i++) {
          const precedingContext = segments[i].slice(-40);
          expect(precedingContext).toMatch(/never hardcode|such as/);
        }
      });

      it("states that ce-harness, not the runner, owns selection, and forbids relying on automatic skill/agent matching", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ").toLowerCase();

        expect(normalized).toMatch(/ce-harness .* owns lens selection/i);
        expect(normalized).toMatch(
          /never rely on the runner's own automatic skill or agent matching/,
        );
      });

      it("gives operational/runtime concerns precedence over structural concerns on overlap", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/operational\/runtime concern.{0,120}take precedence/i);
      });

      it("asks the user when multiple lenses match, and always allows explicit override", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/two or more lenses match.*ask which to apply/i);
        expect(normalized).toMatch(/always allow an? explicit user override/i);
      });

      it("auto-selects without asking when exactly one lens clearly matches", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /If exactly one lens clearly matches, select it and continue -- no need\s*to ask/i,
        );
      });

      it("preserves the presented order when the user says 'all'", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /literal\s*word `all` \(apply every matching lens, in the order they were\s*presented\)/i,
        );
      });

      it('continues normally and reports "Lenses applied: None" when nothing clearly matches', async () => {
        const content = await readTemplate();

        expect(content).toMatch(/continue normally/i);
        expect(content).toContain("Lenses applied: None");
        expect(content).toMatch(/this is not a failure/i);
      });

      it("loads each selected lens as an ordinary reasoning input, never a subagent or delegated conversation", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/load each one's file as an ordinary reasoning input/i);
        expect(normalized).toMatch(/do not spawn a subagent/i);
      });

      it("states lenses are additive and multiple may be selected without repeating the baseline pass", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/Lenses are additive, not mutually exclusive/i);
        expect(normalized).toMatch(
          /the user may pick one, several, all, or none.*not a single-choice menu/i,
        );
        expect(normalized).toMatch(/literal word `all`/i);
        expect(normalized).toMatch(/literal word `none`/i);
        expect(normalized).toMatch(
          /one review with several layers, never one review per lens/i,
        );
      });

      it("requires de-duplicating repeated lens names and preserving user-given order", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/De-duplicate repeated names without loading the same lens twice/i);
        expect(normalized).toMatch(/preserve the order the user\s*named them in/i);
      });

      it("explains and re-asks rather than silently dropping an unresolvable lens name", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/do not drop it silently/i);
        expect(normalized).toMatch(
          /explain which name\(s\) could not be resolved, list the valid lens\s*names, and ask again/i,
        );
      });

      it("extends the explicit override to one or more named lenses, validated the same way", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /if the user has already named\s*one or more specific lenses \(or "none"\) before this step runs/i,
        );
      });

      it("includes a '## Lens Coverage' report section with the top-level fields and a per-lens table", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/## Lens Coverage/);
        expect(content).toMatch(/\*\*Lenses applied:\*\*/);
        expect(content).toMatch(/\*\*Other lenses considered:\*\*/);
        expect(content).toMatch(
          /\| Lens \| Selection rationale \| Lens checks applied \| Additional checks beyond the baseline pass \|/,
        );
        expect(content).toMatch(/N\/A -- no lens applied/);
      });

      it('never uses "specialist" terminology anywhere in the operational body', async () => {
        const content = await readTemplate();

        expect(content).not.toMatch(/specialist/i);
      });
    });

    describe("Baseline adversarial pass (mandatory, runner- and lens-independent)", () => {
      it("appears before lens selection and covers all seven required checks", async () => {
        const content = await readTemplate();

        const baselineIdx = content.indexOf("Baseline adversarial pass");
        const lensSelectIdx = content.indexOf("Select one or more lenses");
        expect(baselineIdx).toBeGreaterThan(-1);
        expect(lensSelectIdx).toBeGreaterThan(-1);
        expect(baselineIdx).toBeLessThan(lensSelectIdx);

        expect(content).toMatch(/Coverage of the change itself/i);
        expect(content).toMatch(/Consistency across equivalent call sites/i);
        expect(content).toMatch(/Integration and wiring between layers/i);
        expect(content).toMatch(/Positive and negative test coverage/i);
        expect(content).toMatch(/What the tests actually prove/i);
        expect(content).toMatch(/Regressions from partial or inconsistent rollout/i);
        expect(content).toMatch(/Undocumented scope changes/i);
      });

      it("states the baseline pass is mandatory, runner-/lens-independent, and never skipped or folded into a lens", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /the Step 6 baseline pass is mandatory and runner-\/lens-independent/i,
        );
        expect(normalized).toMatch(/never skip it or fold it silently into the lens/i);
        expect(content).toMatch(/A change is\s*never reviewed through a lens alone/i);
      });

      it("frames a lens as an additive layer, not a filter that narrows the review to one domain", async () => {
        const content = await readTemplate();

        expect(content).toMatch(
          /A lens is an additional reasoning layer, not a filter that narrows the\s*review to one domain/,
        );
        expect(content).toMatch(
          /A lens is an additional\s*reasoning layer, never a filter that narrows the review to one domain/,
        );
        expect(content).toMatch(/it never replaces, shortcuts, or narrows it/i);
      });

      it("feeds baseline findings into a dedicated 'Baseline Review Coverage' report section with all five fields", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/## Baseline Review Coverage/);
        expect(content).toMatch(/\*\*Changed areas examined:\*\*/);
        expect(content).toMatch(/\*\*Equivalent call sites checked:\*\*/);
        expect(content).toMatch(/\*\*Tests inspected:\*\*/);
        expect(content).toMatch(/\*\*Integration boundaries traced:\*\*/);
        expect(content).toMatch(/\*\*Gaps or inaccessible evidence:\*\*/);

        const baselineSectionIdx = content.indexOf("## Baseline Review Coverage");
        const lensSectionIdx = content.indexOf("## Lens Coverage");
        expect(baselineSectionIdx).toBeGreaterThan(-1);
        expect(lensSectionIdx).toBeGreaterThan(-1);
        expect(baselineSectionIdx).toBeLessThan(lensSectionIdx);
      });
    });

    describe("Four-axis classification (Severity / Confidence / Merge impact / Area)", () => {
      it("defines Severity, Confidence, and Merge impact as independent axes, warning against collapsing them", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/Four independent axes/i);
        expect(normalized).toMatch(
          /Severity, Confidence, and Merge impact are three independent\s*judgments, not restatements of each other/i,
        );
        expect(normalized).toMatch(
          /a finding can be high-Severity with a `Follow-up` Merge impact/i,
        );
        expect(normalized).toMatch(
          /a `MINOR`-Severity finding can still be\s*`Blocking`/i,
        );
      });

      it("guards against using BLOCKER as a synonym for 'please fix before merge'", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");
        const matches = normalized.match(
          /\*\*Do not use `?BLOCKER`? merely as a synonym for "please fix before merge"\*\*/g,
        );

        // Stated at least twice: once in the classification step, once in
        // the guardrails list.
        expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
      });

      it("defines the Merge impact enum as exactly Blocking / Non-blocking / Follow-up", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/\*\*Merge impact\*\*/);
        expect(content).toMatch(/\*\*Blocking\*\* -- this finding, on its own/);
        expect(content).toMatch(/\*\*Non-blocking\*\* -- does not block merge by itself/);
        expect(content).toMatch(/\*\*Follow-up\*\* -- does not need to gate this change at all/);
      });

      it("keeps Severity defined as BLOCKER/MAJOR/MINOR with the original impact-based criteria", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/\*\*BLOCKER\*\*: critical impact/);
        expect(content).toMatch(/\*\*MAJOR\*\*: substantial correctness/);
        expect(content).toMatch(/\*\*MINOR\*\*: limited impact/);
      });

      it("keeps Confidence defined as High/Medium/Low with unchanged evidentiary criteria", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/\*\*High\*\* -- demonstrated by concrete code flow/);
        expect(content).toMatch(/\*\*Medium\*\* -- strongly supported by code reading/);
        expect(content).toMatch(/\*\*Low\*\* -- plausible but speculative/);
      });
    });

    describe("Two-table finding split (in-change vs pre-existing/adjacent)", () => {
      it("sorts every finding into exactly one of two named groups with explicit membership criteria", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/Sort each finding into exactly one of two groups/i);
        expect(content).toMatch(/\*\*Findings affecting this change\*\* -- a finding belongs here when the\s*change:/i);
        expect(content).toMatch(/\*\*Pre-existing or adjacent issues\*\* -- everything else/i);
      });

      it("includes a '## Findings Affecting This Change' table that alone determines the verdict", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/## Findings Affecting This Change/);
        expect(content).toMatch(/This table alone determines the Overall Verdict/i);
        expect(content).toMatch(
          /\| Severity \| Confidence \| Merge impact \| Area \| Affected Requirement\/Design\/Task \| Finding \| Evidence \| Impact \| Recommended Fix \|/,
        );
        expect(content).toMatch(/Or, if none: "None found\."/);
      });

      it("includes a '## Pre-Existing or Adjacent Issues' table that never determines the verdict on its own", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/## Pre-Existing or Adjacent Issues/);
        expect(content).toMatch(/These never determine the Overall Verdict on their own/i);
        expect(content).toMatch(
          /\| Severity \| Confidence \| Area \| Issue \| Evidence \| Why it is outside this change \| Suggested follow-up \|/,
        );
        expect(content).toMatch(/Or, if none: "None noticed\."/);
      });

      it("never lets pre-existing/adjacent issues cause FAIL or expand into a full-system audit", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Pre-existing or adjacent issues, on their own, must never cause `FAIL`/i,
        );
        expect(normalized).toMatch(
          /must not be allowed to expand a focused review of\s*this change into a full-system audit/i,
        );
        expect(normalized).toMatch(
          /Do not let a\s*repository-wide adjacent issue silently turn a focused review of this\s*change into a full-system audit/i,
        );
      });
    });

    describe("Verdict rules derived only from in-change findings", () => {
      it("states the verdict is derived only from the Findings Affecting This Change table", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /The verdict is derived \*\*only\*\* from the "Findings Affecting This Change"\s*table/i,
        );
      });

      it("defines FAIL, PASS WITH GAPS, and PASS (adversarial) using exactly the PASS/PASS WITH GAPS/FAIL tokens", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`FAIL` -- at least one finding affecting this change has Merge impact\s*`Blocking`/i,
        );
        expect(normalized).toMatch(
          /`PASS WITH GAPS` -- no `Blocking` findings affecting this change, but/i,
        );
        expect(normalized).toMatch(
          /`PASS` \(adversarial\) -- no `Blocking` or `Non-blocking` findings/i,
        );

        // The emitted verdict token itself must remain exactly one of the
        // original three-way vocabulary shared with /verify -- "(adversarial)"
        // is prose clarification only, never part of the token written into
        // the report body.
        expect(content).toMatch(/^PASS$/m);
      });
    });

    describe("Preserved mindset and evidence guardrails", () => {
      it("keeps the assume-flaws-until-evidence framing and red-team mindset intact", async () => {
        const content = await readTemplate();

        expect(content).toMatch(
          /independent adversarial reviewer/i,
        );
        expect(content).toMatch(
          /Assume gaps, flaws, regressions, or unsafe behavior may exist/i,
        );
        expect(content).toMatch(/Try to break the implementation/i);
        expect(content).toMatch(/Never invent findings merely to appear adversarial/i);
      });

      it("keeps the Area taxonomy and file/line evidence discipline intact", async () => {
        const content = await readTemplate();

        expect(content).toMatch(
          /Logic, Auth\/Authz, Data integrity, Error handling, Tests, Spec conformance,\s*Security, Performance, Docs\/Spec, Other:/,
        );
        expect(content).toMatch(/cite concrete file paths and line ranges where available/i);
        expect(content).toMatch(/Avoid vague references\./);
      });
    });

    describe("Environment-mutation safety", () => {
      it("never performs mutation automatically -- states this in the Guardrails section", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Never independently mutate database schema\/data, infrastructure,\s*external services, or developer configuration \(e\.g\. running a\s*migration such as `prisma migrate deploy`, a seed, a reset,\s*`terraform apply`, `kubectl apply`, or any similar mutating command\)\s*without explicit user approval/i,
        );
      });

      it("applies the same mutation guardrail identically in both workspace types", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /this\s*applies identically in both workspace types/i,
        );
        // The guardrail lives in the shared Guardrails list (Step 10), which
        // is not duplicated per workspace type.
        const occurrences =
          content.split("Never independently mutate database schema/data").length - 1;
        expect(occurrences).toBe(1);
      });

      it("prefers challenging a prior /verify report's mutation evidence over rerunning the mutation", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /If the prior report already contains adequate evidence that a\s*migration or other state-changing acceptance criterion was exercised/i,
        );
        expect(normalized).toMatch(
          /challenge that evidence -- was it sufficient, does it still\s*hold against the current diff -- rather than re-running the mutation\s*yourself/i,
        );
        expect(normalized).toMatch(
          /prefer challenging\s*a prior `\/verify` report's mutation evidence \(Step 4\) over re-running\s*the mutation/i,
        );
      });

      it("asks first, explaining why, before any additional state-changing operation to investigate a finding", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /If additional mutation is genuinely necessary to\s*investigate a finding, explain why and ask first/i,
        );
        expect(normalized).toMatch(
          /never infer an\s*environment is disposable merely because it's named "test"/i,
        );
      });

      it("REGRESSION: never runs a schema migration against an existing local test database merely to make the test suite runnable", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        // The motivating real-world failure: an adversarial review must not
        // decide, on its own, to run `prisma migrate deploy` (or any
        // similarly mutating command) against a pre-existing local test
        // database just to unblock a test run. This is exactly "mutation
        // unrelated to what's being investigated performed to make an
        // environment usable" -- forbidden without explicit approval.
        expect(normalized).toMatch(/Never independently mutate database schema\/data/i);
        expect(normalized).toMatch(/prisma migrate deploy/);
        expect(normalized).toMatch(
          /never run a migration against an\s*existing local test database merely to make the test suite runnable/i,
        );
      });

      it("cross-references /verify's Docker safety checks rather than re-deriving them", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /The same applies to Docker specifically: never reuse,\s*stop, or otherwise touch a container or Compose project without first\s*confirming \(via its `com\.docker\.compose\.project\.working_dir` label\)\s*that it actually belongs to `\$CE_WORKTREE`/i,
        );
        expect(normalized).toMatch(
          /see `\/verify`'s "Docker\s*safety" \(Step 8\) for the full ownership\/collision\/port-conflict checks\s*this command relies on rather than re-deriving/i,
        );
      });
    });

    describe("Existing PR review mode (first-class support)", () => {
      it("detects the workspace type from CE_DIFF_BASE/CE_DIFF_HEAD before resolving anything", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Detect the workspace type before anything else.*if `CE_DIFF_BASE` and `CE_DIFF_HEAD` are both set, this is an.*Existing PR review.*workspace/i,
        );
        // The detection guidance appears before "## 1. Resolve the review scope".
        const guardIndex = content.search(/Detect the workspace type before anything else/i);
        const step1Index = content.search(/^## 1\. Resolve the review scope/m);
        expect(guardIndex).toBeGreaterThan(-1);
        expect(step1Index).toBeGreaterThan(-1);
        expect(guardIndex).toBeLessThan(step1Index);
      });

      it("never resolves, requires, or invents an OpenSpec change in an Existing PR review workspace", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /never attempt to resolve, require, or\s*create an OpenSpec change here/i,
        );
        expect(normalized).toMatch(
          /never resolve, require, or invent\s*an OpenSpec change/i,
        );
      });

      it("never performs proposal/design/tasks/spec conformance checks in review mode", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        const occurrences = normalized.match(
          /never perform proposal\/design\/tasks\/spec\s*conformance checks/gi,
        );
        expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(2);
      });

      it("uses the PR description, repository conventions/documentation, and the commit range as the review baseline", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/\*\*The PR description\*\*/i);
        expect(normalized).toMatch(/gh pr view/);
        expect(normalized).toMatch(
          /\*\*Repository conventions and documentation\*\*/i,
        );
        expect(normalized).toMatch(/AGENTS\.md.*README.*CONTRIBUTING/i);
        expect(normalized).toMatch(/\*\*The commit range itself\*\*/i);
      });

      it("defines an explicit, official report location distinct from a change's reports/ directory", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/mkdir -p "<root\.path>\/reviews"/);
        expect(content).toMatch(
          /<root\.path>\/reviews\/<YYYY-MM-DD>-adversarial-review\.md/,
        );
        expect(normalized).toMatch(/official, dedicated report location/i);
        expect(normalized).toMatch(/never invent a different one/i);
      });

      it("report structure includes both Change and Pull request fields, with guidance to include exactly one", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(content).toMatch(/\*\*Review type:\*\* OpenSpec change \/ Existing PR review/);
        expect(content).toMatch(/\*\*Change:\*\* <changeRoot> -- Implementation workspaces only/);
        expect(content).toMatch(
          /\*\*Pull request:\*\*.*-- Existing PR review workspaces only/,
        );
        expect(normalized).toMatch(
          /Include exactly one of \*\*Change:\*\* \/ \*\*Pull request:\*\* below.*never both/i,
        );
      });

      it("skips the verify-report-challenge step entirely and records N/A in the report", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /\(Implementation workspaces only\)/,
        );
        expect(normalized).toMatch(
          /`\/verify` refuses to run in an Existing PR review workspace.*so there is never a verify report to look for there\. Skip this\s*step entirely/i,
        );
        expect(normalized).toMatch(
          /N\/A -- \/verify does not run in an\s*Existing PR review workspace/i,
        );
      });

      it("shares the mindset, baseline pass, lens selection, classification, and verdict rules unchanged across both workspace types", async () => {
        const content = await readTemplate();

        // These headings/sections are not duplicated per-mode -- exactly one
        // of each, used by both workspace types.
        for (const heading of [
          "## 2. Mindset",
          "## 6. Baseline adversarial pass",
          "## 7. Select one or more lenses",
          "### Classify each finding",
          "## Overall Verdict",
        ]) {
          const occurrences = content.split(heading).length - 1;
          expect(occurrences).toBe(1);
        }
      });

      it("still preserves the intro's dual-mode framing without altering the two locked lidr-specboot sentences verbatim", async () => {
        const content = await readTemplate();

        // Provenance-locked verbatim sentences (see THIRD_PARTY_NOTICES.md) --
        // must survive this restructuring unchanged.
        expect(content).toMatch(
          /This skill is intended for the verification window of spec-driven\ndevelopment \(after implementation, before archiving\), when the human runs\na different agent or session than the one that implemented the change\./,
        );
        expect(content).toMatch(
          /Do not prescribe which agent, model, or IDE to use\. That is the human's\nchoice\./,
        );

        expect(content).toMatch(/\*\*Implementation workspace\*\*/);
        expect(content).toMatch(/\*\*Existing PR review workspace\*\*/);
      });
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
