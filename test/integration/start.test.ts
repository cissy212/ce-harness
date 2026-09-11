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
import { setupFakeClaude, teardownFakeClaude, type FakeClaudeEnv } from "../helpers/fakeClaude.js";
import { nonExistentCodeGraphBin } from "../helpers/fakeCodeGraph.js";
import { nonExistentOsascriptBin } from "../helpers/fakeOsascript.js";

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
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
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
    delete process.env.CE_OSASCRIPT_BIN;
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

  it("creates and registers a durable, project-scoped OpenSpec store, and persists its metadata", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const { readWorkspace } = await import("../../src/core/workspace.js");
    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

    expect(workspace.openSpec).toBeDefined();
    expect(workspace.openSpec?.storeId).toMatch(/^ce-/);
    expect(workspace.openSpec?.durable).toBe(true);
    // Durable: outside the workspace tree entirely, not <workspace>/openspec.
    expect(workspace.openSpec?.root).not.toBe(join(workspace.workspacePath, "openspec"));
    expect(workspace.openSpec?.root.startsWith(join(harnessHomeDir, "openspec"))).toBe(true);
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

  it("prints a concise startup summary: workspace ready, worktree location, VS Code command, and next step", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    expect(output).toMatch(/Workspace ready\./);
    expect(output).toMatch(new RegExp(`Worktree\\n${escapeRegExp(worktreePath)}`));
    expect(output).toMatch(new RegExp(`Open in VS Code\\ncode ${escapeRegExp(worktreePath)}`));
    expect(output).toMatch(/Next suggested step\n\/explore/);
    expect(output).toMatch(new RegExp(`Launching OpenCode in "${escapeRegExp(worktreePath)}"`));
    // Deliberately not part of ce start's own concise summary anymore --
    // available via `ce status` instead (see test/integration/status.test.ts).
    expect(output).not.toMatch(/OpenSpec store:/);
  });

  it("refuses to start when the source repository has uncommitted changes", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    await makeDirty(repoDir);

    await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
      /uncommitted or untracked changes/i,
    );
  });

  it("succeeds while another workspace is already the default, preserving it untouched, and makes the new one the default", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { readActivePointer, readWorkspace, workspaceExistsOnDisk } = await import(
      "../../src/core/workspace.js"
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const project = basenameOf(repoDir);
    const beforeSecondStart = await readWorkspace(project, "issue-1");

    // Must not throw -- this is the exact E2E blocker being fixed.
    await expect(startCommand({ repo: repoDir, issue: "issue-2" })).resolves.not.toThrow();

    // #130-equivalent (issue-1) is completely untouched.
    expect(workspaceExistsOnDisk(project, "issue-1")).toBe(true);
    const afterSecondStart = await readWorkspace(project, "issue-1");
    expect(afterSecondStart).toEqual(beforeSecondStart);
    expect(existsSync(join(harnessHomeDir, "worktrees", project, "issue-1"))).toBe(true);

    // #143-equivalent (issue-2) was created normally.
    expect(workspaceExistsOnDisk(project, "issue-2")).toBe(true);

    // The new workspace is now the default.
    const pointer = await readActivePointer();
    expect(pointer).toEqual({ project, sanitizedIssue: "issue-2" });
  });

  it("prints a non-alarming note pointing back at the previous default workspace when start switches it", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    logSpy.mockClear();
    await startCommand({ repo: repoDir, issue: "issue-2" });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    const project = basenameOf(repoDir);
    expect(output).toMatch(
      new RegExp(`Note: ${project}/issue-1 was the previous default workspace and is untouched`),
    );
    expect(output).toMatch(new RegExp(`ce resume ${project}/issue-1`));
  });

  it("prints no previous-default note on the very first ce start (nothing to switch from)", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).not.toMatch(/previous default workspace/);
  });

  it("duplicate start of the exact same, already-existing workspace is still rejected, with a targeted (not bare) recovery suggestion", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    try {
      await startCommand({ repo: repoDir, issue: "issue-1" });
      expect.fail("expected startCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      const project = basenameOf(repoDir);
      // The worktree-exists check fires first (before the workspace-dir
      // check), so this is the message actually reached -- rejection
      // itself is what matters here; "workspace already exists"
      // wording is covered by other, more targeted tests elsewhere.
      expect(ceError.message).toMatch(/already exists/i);
      // Never a bare `ce cleanup` -- that would now act on whichever
      // workspace is the current *default*, not necessarily this one.
      expect(ceError.recovery).toContain(`ce cleanup ${project}/issue-1`);
      expect(ceError.recovery).not.toContain("`ce cleanup`");
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

      await statusCommand({ verbose: true });

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

    it("fetches and succeeds using the newly-detected remote default branch, even when it was never locally fetched before this run", async () => {
      const remoteDir = await createBareRemote("develop");
      const cloneDir = await cloneRepo(remoteDir);
      try {
        // The remote's default branch changes after the clone -- neither
        // a local "main" branch nor an origin/main remote-tracking ref
        // exists in cloneDir yet.
        await execa("git", ["-C", remoteDir, "branch", "main"]);
        await execa("git", ["-C", remoteDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
        const branchesBefore = (await execa("git", ["-C", cloneDir, "branch", "--list"])).stdout;
        expect(branchesBefore).not.toMatch(/\bmain\b/);

        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: cloneDir, issue: "issue-1" });

        const workspace = await readWorkspace(basenameOf(cloneDir), "issue-1");
        expect(workspace.baseBranch).toBe("main");
      } finally {
        await rm(remoteDir, { recursive: true, force: true });
        await rm(cloneDir, { recursive: true, force: true });
      }
    });

    it("fails with an actionable error, before creating any persistent resource, when the remote can't be reached to fetch the detected base branch", async () => {
      let remoteDir: string | undefined = await createBareRemote("develop");
      const cloneDir = await cloneRepo(remoteDir);
      try {
        // Simulate an unreachable remote (deleted, offline, network
        // down) -- point origin at a path that no longer exists. The
        // cached refs/remotes/origin/HEAD symref (from the clone) still
        // names "develop", so detection itself succeeds; it's the fetch
        // that must fail.
        const goneRemote = remoteDir;
        remoteDir = undefined;
        await rm(goneRemote, { recursive: true, force: true });
        await execa("git", ["-C", cloneDir, "remote", "set-url", "origin", join(goneRemote, "does-not-exist")]);

        const { startCommand } = await import("../../src/commands/start.js");
        const { readActivePointer } = await import("../../src/core/workspace.js");

        await expect(startCommand({ repo: cloneDir, issue: "issue-1" })).rejects.toThrow(
          /Could not fetch "origin\/develop"/,
        );

        expect(await readActivePointer()).toBeNull();
        expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
        expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
      } finally {
        if (remoteDir) await rm(remoteDir, { recursive: true, force: true });
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

    it("refuses to start when the project's durable store id is already registered at an unexpected path, without adopting it", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { setupStore, unregisterStore } = await import("../../src/core/openspec.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      // Establish this project's real Project Identity (and its real
      // durable store id) first, so the id used below is exactly the one
      // ce-harness will resolve back to on the next `ce start` for this
      // same repository -- Project Identity mints an opaque random id, so
      // it can no longer be predicted ahead of time the way the legacy,
      // path-hash-keyed id could.
      await startCommand({ repo: repoDir, issue: "issue-0" });
      const established = await readWorkspace(basenameOf(repoDir), "issue-0");
      const storeId = established.openSpec!.storeId;
      await cleanupCommand({});

      // Re-register that same store id at a path that does NOT match the
      // project's expected durable root -- a genuine conflict ce-harness
      // cannot safely resolve on its own (e.g. some other registration
      // entirely).
      await unregisterStore(fakeOpenSpec.dir, storeId);
      const preExistingRoot = join(fakeOpenSpec.dir, "pre-existing-store");
      await setupStore(fakeOpenSpec.dir, storeId, preExistingRoot);

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

    it("a second workspace for the same project reuses the first workspace's durable OpenSpec store, without re-`setup`ing it", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const first = await readWorkspace(basenameOf(repoDir), "issue-1");
      await cleanupCommand({});

      // The durable store must have survived cleanup of the first workspace.
      const { readFile } = await import("node:fs/promises");
      let registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(registry[first.openSpec!.storeId]).toBeDefined();

      await startCommand({ repo: repoDir, issue: "issue-2" });
      const second = await readWorkspace(basenameOf(repoDir), "issue-2");

      expect(second.openSpec?.storeId).toBe(first.openSpec?.storeId);
      expect(second.openSpec?.root).toBe(first.openSpec?.root);
      expect(second.openSpec?.durable).toBe(true);

      // Re-`setup`ing an already-registered id would fail (store_id_conflict
      // in the fake, matching the real CLI's non-idempotent behavior) -- the
      // fact that `ce start` succeeded at all proves it reused rather than
      // re-created it.
      registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(Object.keys(registry)).toHaveLength(1);
    });

    it("different projects (different repositories) never share a durable OpenSpec store", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const otherRepoDir = await createTempRepo();
      try {
        await startCommand({ repo: repoDir, issue: "issue-1" });
        const first = await readWorkspace(basenameOf(repoDir), "issue-1");

        const { clearActivePointer } = await import("../../src/core/workspace.js");
        await clearActivePointer();

        await startCommand({ repo: otherRepoDir, issue: "issue-1" });
        const second = await readWorkspace(basenameOf(otherRepoDir), "issue-1");

        expect(second.openSpec?.storeId).not.toBe(first.openSpec?.storeId);
        expect(second.openSpec?.root).not.toBe(first.openSpec?.root);
      } finally {
        await rm(otherRepoDir, { recursive: true, force: true });
      }
    });

    it("--from Implementation workspaces get the same durable, project-scoped store as the default flow", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await execa("git", ["-C", repoDir, "checkout", "-b", "dependency-branch"]);
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "issue-1", from: "dependency-branch" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      const { generateProjectStoreId, expectedDurableOpenSpecRoot, isValidProjectId } = await import(
        "../../src/core/openspecId.js"
      );
      expect(workspace.openSpec?.projectId).toBeDefined();
      expect(isValidProjectId(workspace.openSpec!.projectId!)).toBe(true);
      expect(workspace.openSpec?.storeId).toBe(generateProjectStoreId(workspace.openSpec!.projectId!));
      expect(workspace.openSpec?.root).toBe(expectedDurableOpenSpecRoot(workspace.openSpec!.projectId!));
      expect(workspace.openSpec?.durable).toBe(true);
    });

    it("an Existing PR review workspace (--base/--head) gets the same durable, project-scoped store", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await (await import("node:fs/promises")).writeFile(
        join(repoDir, "feature.txt"),
        "new feature\n",
        "utf8",
      );
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "feature commit"]);
      const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "review-1", base: baseSha, head: headSha });
      const workspace = await readWorkspace(basenameOf(repoDir), "review-1");

      const { generateProjectStoreId, expectedDurableOpenSpecRoot, isValidProjectId } = await import(
        "../../src/core/openspecId.js"
      );
      expect(workspace.openSpec?.projectId).toBeDefined();
      expect(isValidProjectId(workspace.openSpec!.projectId!)).toBe(true);
      expect(workspace.openSpec?.storeId).toBe(generateProjectStoreId(workspace.openSpec!.projectId!));
      expect(workspace.openSpec?.root).toBe(expectedDurableOpenSpecRoot(workspace.openSpec!.projectId!));
      expect(workspace.openSpec?.durable).toBe(true);
    });

    it("a later failure in the SAME session that created the durable store still rolls it back (storeCreatedThisSession)", async () => {
      process.env.FAKE_OPENSPEC_FAIL_DOCTOR = "1";
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).rejects.toThrow(
        /failed its health check/i,
      );

      const { readFile } = await import("node:fs/promises");
      const registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(Object.keys(registry)).toHaveLength(0);
    });

    it("a reuse health-check failure never unregisters the pre-existing durable store (rollback correctness)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      // First workspace creates the durable store for real.
      await startCommand({ repo: repoDir, issue: "issue-1" });
      const first = await readWorkspace(basenameOf(repoDir), "issue-1");
      await cleanupCommand({});

      // Second workspace: the pre-flight check still finds the store
      // registered at the expected root (reuse decided), but the reuse
      // branch's own post-creation health check then reports unhealthy --
      // exercising the exact case that matters: this session did NOT
      // create the store, so its rollback must never unregister it, even
      // though *a* health check failed.
      process.env.FAKE_OPENSPEC_FAIL_DOCTOR = "1";
      await expect(startCommand({ repo: repoDir, issue: "issue-2" })).rejects.toThrow(
        /failed its health check/i,
      );

      const { readFile } = await import("node:fs/promises");
      const registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
      expect(registry[first.openSpec!.storeId]).toBeDefined();
    });
  });

  describe("Project Identity", () => {
    it("recognizes the same repository after being cloned to a differently-named path, and reuses its durable store", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const remoteDir = await createBareRemote("main");
      const cloneA = await cloneRepo(remoteDir, "ce-harness-identity-clone-a-");
      const cloneB = await cloneRepo(remoteDir, "ce-harness-identity-clone-b-");
      try {
        await startCommand({ repo: cloneA, issue: "issue-1" });
        const first = await readWorkspace(basenameOf(cloneA), "issue-1");
        await cleanupCommand({});

        await startCommand({ repo: cloneB, issue: "issue-1" });
        const second = await readWorkspace(basenameOf(cloneB), "issue-1");

        expect(second.openSpec?.projectId).toBe(first.openSpec?.projectId);
        expect(second.openSpec?.storeId).toBe(first.openSpec?.storeId);
        expect(second.openSpec?.root).toBe(first.openSpec?.root);

        // Reused, not re-created -- only one entry in the registry.
        const { readFile } = await import("node:fs/promises");
        const registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
        expect(Object.keys(registry)).toHaveLength(1);
      } finally {
        await rm(remoteDir, { recursive: true, force: true });
        await rm(cloneA, { recursive: true, force: true });
        await rm(cloneB, { recursive: true, force: true });
      }
    });

    it("refuses with a CANDIDATE hint when only the origin URL matches (root commit differs), naming the matched project id", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      // A URL-shaped origin, not a raw local filesystem path: a local
      // path remote is deliberately excluded from identity evidence
      // altogether (see normalizeRemoteUrl) since it's never meaningful
      // cross-checkout evidence, so this test needs an origin shape that
      // actually IS comparable evidence.
      const sharedOriginUrl = "https://example.invalid/acme/widgets.git";
      const clone = await createTempRepo("ce-harness-identity-origin-");
      const unrelatedRepo = await createTempRepo("ce-harness-identity-unrelated-");
      try {
        await execa("git", ["-C", clone, "remote", "add", "origin", sharedOriginUrl]);
        await startCommand({ repo: clone, issue: "issue-1" });
        const established = await readWorkspace(basenameOf(clone), "issue-1");
        const projectId = established.openSpec!.projectId!;
        await cleanupCommand({});

        // Same origin URL, but a completely unrelated commit history --
        // root commit will not agree (createTempRepo gives every call a
        // unique root commit -- see its own doc comment).
        await execa("git", ["-C", unrelatedRepo, "remote", "add", "origin", sharedOriginUrl]);

        await expect(startCommand({ repo: unrelatedRepo, issue: "issue-1" })).rejects.toThrow(
          new RegExp(projectId),
        );
        await expect(startCommand({ repo: unrelatedRepo, issue: "issue-1" })).rejects.toThrow(
          /partially matches/i,
        );
      } finally {
        await rm(clone, { recursive: true, force: true });
        await rm(unrelatedRepo, { recursive: true, force: true });
      }
    });

    it("--new-project mints a separate identity even when the repository would otherwise be recognized", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const remoteDir = await createBareRemote("main");
      const cloneA = await cloneRepo(remoteDir, "ce-harness-identity-newproj-a-");
      const cloneB = await cloneRepo(remoteDir, "ce-harness-identity-newproj-b-");
      try {
        await startCommand({ repo: cloneA, issue: "issue-1" });
        const first = await readWorkspace(basenameOf(cloneA), "issue-1");
        await cleanupCommand({});

        await startCommand({ repo: cloneB, issue: "issue-1", newProject: true });
        const second = await readWorkspace(basenameOf(cloneB), "issue-1");

        expect(second.openSpec?.projectId).not.toBe(first.openSpec?.projectId);
        expect(second.openSpec?.storeId).not.toBe(first.openSpec?.storeId);
      } finally {
        await rm(remoteDir, { recursive: true, force: true });
        await rm(cloneA, { recursive: true, force: true });
        await rm(cloneB, { recursive: true, force: true });
      }
    });

    it("--project-id attaches explicitly to a known project id, even for a repository with no matching signals at all", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const remoteDir = await createBareRemote("main");
      const clone = await cloneRepo(remoteDir, "ce-harness-identity-explicit-");
      const unrelatedRepo = await createTempRepo("ce-harness-identity-explicit-unrelated-");
      try {
        await startCommand({ repo: clone, issue: "issue-1" });
        const established = await readWorkspace(basenameOf(clone), "issue-1");
        const projectId = established.openSpec!.projectId!;
        await cleanupCommand({});

        await startCommand({ repo: unrelatedRepo, issue: "issue-1", projectId });
        const attached = await readWorkspace(basenameOf(unrelatedRepo), "issue-1");

        expect(attached.openSpec?.projectId).toBe(projectId);
        expect(attached.openSpec?.storeId).toBe(established.openSpec?.storeId);
        expect(attached.openSpec?.root).toBe(established.openSpec?.root);
      } finally {
        await rm(remoteDir, { recursive: true, force: true });
        await rm(clone, { recursive: true, force: true });
        await rm(unrelatedRepo, { recursive: true, force: true });
      }
    });

    it("--project-id and --new-project are mutually exclusive", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      await expect(
        startCommand({ repo: repoDir, issue: "issue-1", projectId: "abcdef012345", newProject: true }),
      ).rejects.toThrow(/mutually exclusive/i);
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
        CE_BASE_BRANCH: "main",
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

    it("populates <workspace>/lenses/comment-cleanup/SKILL.md from the vendored external Agent Skill, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const { readFile } = await import("node:fs/promises");

      const copiedPath = join(workspace.workspacePath, "lenses", "comment-cleanup", "SKILL.md");
      const sourcePath = join(templatesRoot(), "lenses", "comment-cleanup", "SKILL.md");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));

      // Mirrored under opencode/agents/ too, via the same generic copy mechanism.
      const mirrorPath = join(workspace.workspacePath, "opencode", "agents", "comment-cleanup", "SKILL.md");
      expect(existsSync(mirrorPath)).toBe(true);
      expect(await readFile(mirrorPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
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

    it('suggests "/adversarial-review" (never "/explore") in the startup summary for an Existing PR review workspace', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();

      const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(repoDir, "feature.txt"), "new feature\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "feature commit"]);
      const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: headSha });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Next suggested step\n\/adversarial-review/);
      expect(output).not.toMatch(/\/explore/);
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

  describe("Explicit starting ref for an Implementation workspace (--from)", () => {
    it("with no --from, default behavior is unchanged: detected base branch, baseRefExplicit absent", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.baseBranch).toBe("main");
      expect(workspace.baseRefExplicit).toBeUndefined();
    });

    it("--from <local branch>: seeds the worktree from that branch, stays an Implementation workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { workspaceType } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { writeFile } = await import("node:fs/promises");

      await execa("git", ["-C", repoDir, "checkout", "-b", "feature/scv-ai-jano-auth"]);
      await writeFile(join(repoDir, "jano.txt"), "completed jano integration\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "jano integration"]);
      const featureSha = (
        await execa("git", ["-C", repoDir, "rev-parse", "feature/scv-ai-jano-auth"])
      ).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "issue-1", from: "feature/scv-ai-jano-auth" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspaceType(workspace)).toBe("Implementation");
      expect(workspace.baseBranch).toBe("feature/scv-ai-jano-auth");
      expect(workspace.baseBranchCommit).toBe(featureSha);
      expect(workspace.baseRefExplicit).toBe(true);
      expect(workspace.diffBase).toBeUndefined();
      expect(workspace.diffHead).toBeUndefined();

      const worktreeHead = (
        await execa("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"])
      ).stdout.trim();
      expect(worktreeHead).toBe(featureSha);
      expect(await readFileText(join(workspace.worktreePath, "jano.txt"))).toBe(
        "completed jano integration\n",
      );
    });

    it("--from origin/<branch>: resolves via the remote-tracking ref when no local branch of that name exists", async () => {
      const remoteDir = await createBareRemote("main");
      const seedDir = await cloneRepo(remoteDir);
      const { writeFile } = await import("node:fs/promises");
      await execa("git", ["-C", seedDir, "checkout", "-b", "feature/scv-ai-jano-auth"]);
      await writeFile(join(seedDir, "jano.txt"), "jano work\n", "utf8");
      await execa("git", ["-C", seedDir, "add", "."]);
      await execa("git", ["-C", seedDir, "commit", "-m", "jano integration"]);
      await execa("git", ["-C", seedDir, "push", "origin", "feature/scv-ai-jano-auth"]);
      await execa("git", ["-C", seedDir, "checkout", "main"]);

      // A fresh clone only creates a local branch for "main" (checked out
      // at clone time) -- "feature/scv-ai-jano-auth" exists only as
      // origin/feature/scv-ai-jano-auth.
      const workRepo = await cloneRepo(remoteDir);
      const localBranch = await execa(
        "git",
        ["-C", workRepo, "rev-parse", "--verify", "feature/scv-ai-jano-auth"],
        { reject: false },
      );
      expect(localBranch.exitCode).not.toBe(0);

      try {
        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({
          repo: workRepo,
          issue: "issue-1",
          from: "origin/feature/scv-ai-jano-auth",
        });

        const workspace = await readWorkspace(basenameOf(workRepo), "issue-1");
        const expectedSha = (
          await execa("git", ["-C", workRepo, "rev-parse", "origin/feature/scv-ai-jano-auth"])
        ).stdout.trim();
        expect(workspace.baseBranch).toBe("origin/feature/scv-ai-jano-auth");
        expect(workspace.baseBranchCommit).toBe(expectedSha);
        expect(workspace.baseRefExplicit).toBe(true);
      } finally {
        await rm(remoteDir, { recursive: true, force: true });
        await rm(seedDir, { recursive: true, force: true });
        await rm(workRepo, { recursive: true, force: true });
      }
    });

    it("an invalid/unresolvable --from ref fails clearly, before creating any persistent resource", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      await expect(
        startCommand({ repo: repoDir, issue: "issue-1", from: "does-not-exist-anywhere" }),
      ).rejects.toThrow(/could not resolve/i);

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout.trim()).toBe("");
    });

    it("--from combined with --base/--head is rejected before creating any persistent resource", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      await expect(
        startCommand({ repo: repoDir, issue: "issue-1", from: "main", base: "main", head: "main" }),
      ).rejects.toThrow(/--from cannot be combined with --base\/--head/i);

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
    });

    it("the launch environment's CE_BASE_BRANCH reflects the --from ref, with no CE_DIFF_BASE/CE_DIFF_HEAD", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { writeFile } = await import("node:fs/promises");

      await execa("git", ["-C", repoDir, "checkout", "-b", "feature/scv-ai-jano-auth"]);
      await writeFile(join(repoDir, "jano.txt"), "jano\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "jano"]);
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "issue-1", from: "feature/scv-ai-jano-auth" });

      const launch = JSON.parse(await readFileText(fakeOpenCode.outputFile));
      expect(launch.env.CE_BASE_BRANCH).toBe("feature/scv-ai-jano-auth");
      expect(launch.env.CE_DIFF_BASE ?? null).toBeNull();
      expect(launch.env.CE_DIFF_HEAD ?? null).toBeNull();
    });

    it("never modifies, moves, or checks out the --from source branch itself", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { writeFile } = await import("node:fs/promises");

      await execa("git", ["-C", repoDir, "checkout", "-b", "feature/scv-ai-jano-auth"]);
      await writeFile(join(repoDir, "jano.txt"), "jano\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "jano"]);
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      const shaBefore = (
        await execa("git", ["-C", repoDir, "rev-parse", "feature/scv-ai-jano-auth"])
      ).stdout.trim();
      const branchBefore = (
        await execa("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"])
      ).stdout.trim();

      await startCommand({ repo: repoDir, issue: "issue-1", from: "feature/scv-ai-jano-auth" });

      const shaAfter = (
        await execa("git", ["-C", repoDir, "rev-parse", "feature/scv-ai-jano-auth"])
      ).stdout.trim();
      const branchAfter = (
        await execa("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"])
      ).stdout.trim();

      expect(shaAfter).toBe(shaBefore);
      expect(branchAfter).toBe(branchBefore); // the original repo's own checkout never moved either
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

    describe("real Oz E2E gap: a bare issue slug alone must not trigger broad, generic exploration", () => {
      it("instructs stopping to ask for the missing task context before looking at the repository, ordered before the broad-exploration step", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

        const confirmIdx = content.indexOf(
          "Confirm you actually know what the task is before exploring the",
        );
        const lookAroundIdx = content.indexOf(
          "Once you know what the task actually is, look around the worktree",
        );
        expect(confirmIdx).toBeGreaterThan(-1);
        expect(lookAroundIdx).toBeGreaterThan(-1);
        expect(confirmIdx).toBeLessThan(lookAroundIdx);

        expect(content).toMatch(/stop here, before looking at the\s*\n?\s*repository/);
        expect(content).toMatch(/AskUserQuestion/);
      });

      it("never requires a formal issue tracker or GitHub issue -- a free-form answer is enough", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

        expect(content).toMatch(/never\s*\n?\s*requires a formal issue tracker or GitHub issue/);
        expect(content).toMatch(/short free-form\s*\n?\s*description is enough/);
      });

      it("does not over-trigger: explicitly tells the agent not to ask when the task is already reasonably clear", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

        expect(content).toMatch(/Do not ask when the task is already reasonably clear/);
      });

      it("restates the rule in the Never section, including the never-require-a-tracker and don't-over-ask clauses", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");
        const neverSection = content.slice(content.indexOf("## Never"));

        expect(neverSection).toMatch(/Never perform broad, generic repository exploration/);
        expect(neverSection).toMatch(/Never\s*\n?\s*require a formal issue tracker or GitHub issue/);
        expect(neverSection).toMatch(/Never ask when the task is already\s*\n?\s*reasonably clear/);
      });
    });

    it("documents the expected openspec subcommands: new change, list, context, status -- never invokes instructions/validate (those write/validate the schema-tracked proposal artifact, which is /propose's job now)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

      expect(content).toMatch(/openspec new change/);
      expect(content).toMatch(/openspec list/);
      expect(content).toMatch(/openspec context/);
      expect(content).toMatch(/openspec status/);

      // No fenced-code-block *invocation* of instructions/validate -- prose
      // may still explain (in the negative) that this command doesn't call
      // them, which is fine and shouldn't trip this check.
      const invocationLines = content.split("\n").filter((line) => /^\s*openspec\s/.test(line));
      expect(invocationLines.some((line) => line.includes("openspec instructions"))).toBe(false);
      expect(invocationLines.some((line) => line.includes("openspec validate"))).toBe(false);
    });

    it("writes its findings to <changeRoot>/explore.md, never as an OpenSpec schema artifact", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

      expect(content).toMatch(/changeRoot.*\/explore\.md/);
      expect(content.toLowerCase()).toMatch(/not.*(an )?openspec schema artifact/);
    });

    it("instructs keeping explore.md concise and scoped to the issue, not a general repository survey", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

      expect(content).toMatch(/Keep it concise and scoped to this issue/);
      expect(content).toMatch(/not a general survey of the/);
    });

    it("tells the agent to report ce open --change as how to view the persisted findings, not an internal path", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8");

      expect(content).toMatch(/ce open\s*\n?\s*--change/);
      expect(content.toLowerCase()).not.toMatch(/\$ce_harness_home/);
    });

    it("never drafts proposal.md, design.md, or tasks.md -- that's /propose's job", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "explore.md"), "utf8").then(
        (text) => text.toLowerCase(),
      );

      expect(content).toMatch(/never draft or write `proposal\.md`, `design\.md`, `tasks\.md`/);
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

  describe("/enrich command template", () => {
    it("copies templates/commands/enrich.md into <workspace>/opencode/commands/, byte-for-byte", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(workspace.workspacePath, "opencode", "commands", "enrich.md");
      const sourcePath = join(templatesRoot(), "commands", "enrich.md");

      const { readFile } = await import("node:fs/promises");
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    });

    it("references CE_OPENSPEC_STORE and requires it before proceeding", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      expect(content).toContain("CE_OPENSPEC_STORE");
      expect(content.toLowerCase()).toMatch(/if `ce_openspec_store` is empty or unset, stop/);
    });

    it("passes --store \"$CE_OPENSPEC_STORE\" on every documented openspec invocation", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      const openspecInvocations = content.split("\n").filter((line) => /^\s*openspec\s/.test(line));
      expect(openspecInvocations.length).toBeGreaterThan(0);
      for (const line of openspecInvocations) {
        expect(line).toContain('--store "$CE_OPENSPEC_STORE"');
      }
    });

    it("documents consuming the Retrieval Contract via `ce retrieve`, with bounded inspection and at most one refinement", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      expect(content).toMatch(/ce retrieve/);
      expect(content).toMatch(/never open more than 5 candidates/i);
      expect(content).toMatch(/at most once more/i);
    });

    it("documents the ready / needs-clarification status contract and the materiality test for questions", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      expect(content).toMatch(/\*\*Status:\*\* ready \| needs-clarification/);
      expect(content).toMatch(/only if a different answer would\s*\n?\s*change what `\/propose` designs/);
      expect(content).toMatch(/do not create a question just to justify this stage/i);
    });

    it("documents re-run detection (existing enrich.md + checked tasks.md) as blocking by default", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      expect(content).toMatch(/re-run/i);
      expect(content).toMatch(/- \[x\]/);
      expect(content).toMatch(/blocking/i);
    });

    it("explicitly forbids designing the implementation or writing design.md/tasks.md", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8").then(
        (text) => text.toLowerCase(),
      );

      expect(content).toMatch(/never design the technical implementation/);
      expect(content).toMatch(/never modify `proposal\.md`, `design\.md`, or `tasks\.md`/);
      expect(content).toMatch(/never modify, create, or delete any file inside the target repository/);
    });

    it("writes its output to <changeRoot>/enrich.md, never as an OpenSpec schema artifact", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      expect(content).toMatch(/changeRoot.*\/enrich\.md/);
      expect(content.toLowerCase()).toMatch(/not.*(an )?openspec schema artifact/);
    });

    it("instructs citing explore.md instead of restating it, to avoid duplicating findings across artifacts", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      expect(content).toMatch(/Keep it concise/);
      expect(content).toMatch(/cite.*explore\.md/i);
      expect(content).toMatch(/never a re-summary of the\s+whole\s+exploration/);
    });

    it("tells the agent to report ce open --change as how to view the persisted artifacts, not an internal path", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      expect(content).toMatch(/ce open --change/);
    });

    it("never places enrich.md inside the target repository or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(existsSync(join(repoDir, "enrich.md"))).toBe(false);
      expect(existsSync(join(worktreePath, "enrich.md"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
      expect(readdirSync(worktreePath).sort()).toEqual([".git", "README.md"]);
    });

    it("on a re-run with implementation already underway, recommends re-running /propose next to realign the artifacts (not just reviewing in-progress work)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

      // Step 3's existing re-run detection (enrich.md exists + tasks.md
      // has a checked task) is untouched -- only step 9's report changed.
      expect(content).toMatch(
        /`enrich\.md` already exists \*\*and\*\* `tasks\.md` exists with at least one\s*\n\s*`- \[x\]` checked task/,
      );
      expect(content).toMatch(
        /say so explicitly and recommend re-running `\/propose` next/,
      );
      expect(content).toMatch(/to realign `proposal\.md`\/`design\.md`\/`tasks\.md`/);
    });

    describe("selecting the change: prefers this workspace's own active change over project-wide discovery", () => {
      it("checks `ce status \"$CE_PROJECT/$CE_ISSUE\"` before falling back to project-wide openspec list discovery", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

        expect(content).toMatch(/ce status "\$CE_PROJECT\/\$CE_ISSUE"/);
        const checkIdx = content.indexOf('ce status "$CE_PROJECT/$CE_ISSUE"');
        const fallbackIdx = content.indexOf("Only now fall back to");
        expect(checkIdx).toBeGreaterThan(-1);
        expect(fallbackIdx).toBeGreaterThan(-1);
        expect(checkIdx).toBeLessThan(fallbackIdx);
      });

      it("auto-uses a sole workspace-associated active change without asking, and only falls back to legacy discovery when ce status reports none", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

        expect(content).toMatch(/Exactly one line, with a real name\*\* -- use it automatically/);
        expect(content).toMatch(/Do\s+not ask the user anything/);
        expect(content).toMatch(/`Active change:\s+\(none\)`\*\* -- this workspace has no/);
      });

      it("states the guardrail explicitly: never use project-wide discovery before checking ce status for this workspace's own change", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");

        expect(content).toMatch(
          /Never select a change via project-wide discovery \(`openspec list`\)\s+before checking `ce status "\$CE_PROJECT\/\$CE_ISSUE"`/,
        );
      });
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

    describe("resolving the change name (real #138 smoke bug: asked to re-describe/re-select an already-associated change)", () => {
      it("checks this workspace's own active change via `ce status \"$CE_PROJECT/$CE_ISSUE\"` before ever asking the user", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

        expect(content).toMatch(/ce status "\$CE_PROJECT\/\$CE_ISSUE"/);
        // The check must come textually before the AskUserQuestion prompt.
        const checkIdx = content.indexOf('ce status "$CE_PROJECT/$CE_ISSUE"');
        const askIdx = content.indexOf("What change do you want to work on?");
        expect(checkIdx).toBeGreaterThan(-1);
        expect(askIdx).toBeGreaterThan(-1);
        expect(checkIdx).toBeLessThan(askIdx);
      });

      it("auto-uses a sole already-associated active change without asking, and only asks when ce status reports none", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

        expect(content).toMatch(
          /Exactly one `Active change:` line, with a real name\*\* -- use\s+it automatically/,
        );
        expect(content).toMatch(/Do not ask the user\s+anything at this point/);
        expect(content).toMatch(/`Active change:\s+\(none\)`\*\* -- there is genuinely no change/);
      });

      it("never re-ask about a name/change the harness already resolved automatically -- the 'already exists' guardrail is scoped to explicit user input only", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

        expect(content).toMatch(
          /If the user \*explicitly\* typed a name[\s\S]{0,400}does \*\*not\*\* apply to step 1's auto-resolved case/,
        );
        expect(content).toMatch(
          /that case is always "continue it," never re-asked/,
        );
      });

      it("states the guardrail explicitly: never ask what to build without first checking ce status for an associated change", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

        expect(content).toMatch(
          /Never ask the user what to build \(step 1\) without first checking `ce status "\$CE_PROJECT\/\$CE_ISSUE"`/,
        );
      });
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

    it("preserves the upstream numbered Steps structure (2-4) unchanged in shape, plus step 1's now-broader change-resolution logic and the later-added provenance-recording and final-status steps (5-6)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(/1\. \*\*Resolve the change name: explicit input, else this workspace's own active change, else ask\*\*/);
      expect(content).toMatch(/2\. \*\*Create the change directory\*\*/);
      expect(content).toMatch(/3\. \*\*Get the artifact build order\*\*/);
      expect(content).toMatch(/4\. \*\*Create artifacts in sequence until apply-ready\*\*/);
      expect(content).toMatch(/5\. \*\*Record provenance\*\*/);
      expect(content).toMatch(/6\. \*\*Show final status\*\*/);
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

    it("consumes a ready enrich.md as requirement input for the artifacts", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(/check for `<changeRoot>\/explore\.md` and `<changeRoot>\/enrich\.md`/);
      expect(content).toMatch(/`ready` -- continue to step 4\./);
      expect(content).toMatch(
        /Treat its Clarified Intent,\s*\n\s*Confirmed Acceptance Criteria, Assumptions, Constraints, Edge\s*\n\s*Cases\/Error Cases, Conflicts Identified, and Relevant Current\/Prior\s*\n\s*Context as requirement input/,
      );
      expect(content).toMatch(
        /never copy\s*\n?\s*`enrich\.md`'s sections wholesale into `proposal\.md`, `design\.md`,\s*\n?\s*or `tasks\.md`/i,
      );
    });

    it("refuses to proceed and surfaces open questions when enrich.md's Status is needs-clarification", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(/`needs-clarification` -- \*\*stop here\.\*\*/);
      expect(content).toMatch(/Do not create or write any\s*\n\s*artifact\./);
      expect(content).toMatch(/list its Open Questions verbatim/);
      expect(content).toMatch(/recommend\s*\n\s*re-running `\/enrich`/);
    });

    it("preserves standalone behavior when enrich.md does not exist", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(
        /If a file doesn't exist at all,\s*\n\s*proceed without it for that one -- `\/propose` must keep working\s*\n\s*standalone, without a prior `\/explore` or `\/enrich` run\./,
      );
      expect(content).not.toMatch(/enrich\.md.{0,80}\brequired\b/is);
    });

    it("reports an artifact checklist and ce open --change, never the durable store's internal path", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(/explore ✓\s+enrich ✓\s+proposal ✓\s+design ✓\s+tasks ✓/);
      expect(content).toMatch(/View them with: `ce open --change`/);
      expect(content.toLowerCase()).not.toMatch(/change name and location/);
    });

    it("tells the agent not to copy explore.md's content wholesale, mirroring the enrich.md guidance", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(/use\s+it for context, not as content to copy/);
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

    it("instructs one clear, independently verifiable success criterion per task.md task, splitting bundled ones semantically rather than mechanically on \"and\"", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(/For `tasks\.md` specifically/);
      expect(content).toMatch(/one clear, independently verifiable success criterion/);
      expect(content).toMatch(/split it into separate tasks/);
      expect(content).toMatch(/never\s*\n?\s*mechanically: do not split a task just because its description\s*\n?\s*contains "and"/);
      expect(content).toMatch(/not artificially microscopic/);
    });

    it("reinforces the tasks.md granularity rule in the Guardrails section", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      const guardrailsSection = content.slice(content.indexOf("**Guardrails**"));
      expect(guardrailsSection).toMatch(
        /Each task in `tasks\.md` has one clear, independently verifiable success criterion/,
      );
      expect(guardrailsSection).toMatch(/never mechanically \(never split solely because a sentence contains "and"\)/);
    });

    it("revises already-done artifacts (not just ready ones) when enrich.md documents a post-implementation requirement change, preserving completed tasks", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      expect(content).toMatch(/Realigning after a requirement change caught mid-implementation/);
      expect(content).toMatch(
        /the loop below only walks `ready` artifacts by\s*\n\s*default, so don't let that skip a `done` artifact the change\s*\n\s*actually touches/,
      );
      expect(content).toMatch(
        /preserve already-completed \(`- \[x\]`\) tasks\s*\n\s*that remain valid under the changed requirement exactly as they are/,
      );
      expect(content).toMatch(/never\s*\n\s*regenerate the file wholesale, and never uncheck a task the change/);

      const guardrailsSection = content.slice(content.indexOf("**Guardrails**"));
      expect(guardrailsSection).toMatch(
        /revise the `done` artifacts it affects instead of skipping them for being `done` already/,
      );
    });

    it("states that realigning artifacts on an already-implemented change invalidates existing verify/adversarial-review evidence, and never suggests /archive", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");

      const guardrailsSection = content.slice(content.indexOf("**Guardrails**"));
      expect(guardrailsSection).toMatch(
        /Realigning `proposal\.md`\/`design\.md`\/`tasks\.md`\/specs on an already-implemented change always invalidates any existing `\/verify`\/`\/adversarial-review` evidence/,
      );
      expect(guardrailsSection).toMatch(
        /never suggest `\/archive` as a consequence of this command; the next step after realigned tasks are implemented is always `\/verify`/,
      );
      // The Output section (what /propose actually tells the user to run
      // next) never mentions /archive at all -- only the Guardrails
      // bullet above names it, to explicitly forbid suggesting it.
      const outputSection = content.slice(content.indexOf("**Output**"), content.indexOf("**Artifact Creation Guidelines**"));
      expect(outputSection).not.toMatch(/\/archive/);
      expect(outputSection).toMatch(/Run `\/apply` to start implementing/);
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
      expect(content).toMatch(/If `state: "all_done"`: congratulate, suggest `\/verify` next/);
      expect(content).toMatch(/Pause if:/);
      expect(content).toMatch(/Task is unclear/);
      expect(content).toMatch(/Error or blocker encountered/);
      expect(content).toMatch(/## Implementation Complete/);
      expect(content).toMatch(/## Implementation Paused/);
      expect(content).toMatch(/contextFiles/);
    });

    it("preserves the upstream numbered Steps structure (1-7) unchanged in shape, with step 4 now also gating on plan freshness before reading context files", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).toMatch(/1\. \*\*Select the change\*\*/);
      expect(content).toMatch(/2\. \*\*Check status to understand the schema\*\*/);
      expect(content).toMatch(/3\. \*\*Get apply instructions\*\*/);
      expect(content).toMatch(/4\. \*\*Gate on the plan's freshness before reading anything, or implementing\*\*/);
      expect(content).toMatch(/\*\*read context\s+files\*\*/);
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

    it("guards against silently implementing an obviously bundled/ambiguous task instead of pausing to recommend re-running /propose", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).toMatch(
        /Task obviously bundles multiple independently completable\s*\n\s*responsibilities/,
      );
      expect(content).toMatch(/not just a description containing "and"/);
      expect(content).toMatch(/recommend re-running\s*\n\s*`\/propose` to split it in `tasks\.md`/);
    });

    it("reinforces the bundled-task guard in the Guardrails section, without turning it into a state machine or new command", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      const guardrailsSection = content.slice(content.indexOf("**Guardrails**"), content.indexOf("**Fluid Workflow Integration**"));
      expect(guardrailsSection).toMatch(
        /a task obviously bundles multiple independently completable responsibilities/i,
      );
      expect(guardrailsSection).toMatch(/never by mechanically splitting on "and"/);
      expect(guardrailsSection).toMatch(/recommend re-running `\/propose` to split it/);

      // Still only 7 steps, no new command/stage introduced by this guard.
      expect(content).toMatch(/7\. \*\*On completion or pause, show status\*\*/);
      expect(content).not.toMatch(/8\. \*\*/);
    });

    it("stops before coding a human-driven requirement/scope change instead of folding it in against a stale agreed contract", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).toMatch(
        /The human says something that changes or adds to the agreed\s*\n\s*requirement\/scope/,
      );
      expect(content).toMatch(/\*\*stop before writing any code for the\s*\n\s*changed\/new part\.\*\*/);
      expect(content).toMatch(
        /run `\/enrich\s*\n\s*<change>` to capture the new intent durably/,
      );
      expect(content).toMatch(/then\s*\n\s*`\/propose <change>` to realign `proposal\.md`\/`design\.md`\/\s*\n\s*`tasks\.md`/);
      expect(content).toMatch(/already-completed\s*\n\s*tasks that remain valid are preserved, not redone/);
    });

    it("distinguishes a material requirement change from normal implementation discoveries that must not bounce back through the workflow", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      expect(content).toMatch(/not an implementation detail discovered while\s*\n\s*coding/);
      expect(content).toMatch(/not a bug fix needed to satisfy the existing spec/);
      expect(content).toMatch(/not\s*\n\s*a clarification that leaves agreed behavior unchanged/);
    });

    it("reinforces the requirement-change guard in the Guardrails section", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

      const guardrailsSection = content.slice(content.indexOf("**Guardrails**"), content.indexOf("**Fluid Workflow Integration**"));
      expect(guardrailsSection).toMatch(/Never implement against a known-stale agreed contract/);
      expect(guardrailsSection).toMatch(/recommend `\/enrich` then `\/propose` to realign the artifacts/);
    });

    describe("completion always points to /verify next, never /archive", () => {
      it("the all_done state-handling instruction says /verify, never archive", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        expect(content).toMatch(
          /If `state: "all_done"`: congratulate, suggest `\/verify` next -- never `\/archive` directly/,
        );
      });

      it("step 7's completion summary says /verify, never archive", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        expect(content).toMatch(
          /If all done: suggest `ce open` to review the implementation, then `\/verify` next -- never `\/archive`/,
        );
      });

      it("the Output On Completion template says /verify, never offers to archive directly", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        const outputOnCompletion = content.slice(
          content.indexOf("**Output On Completion**"),
          content.indexOf("**Output On Pause"),
        );
        expect(outputOnCompletion).toMatch(/run `\/verify` next/);
        expect(outputOnCompletion).toMatch(
          /`\/archive` isn't available yet: it requires a fresh, clean `PASS` from\s*\nboth `\/verify` and `\/adversarial-review`/,
        );
      });

      it("real MAT #138 E2E gap: the completion handoff also gives a ready-to-run `ce open` command to review the implementation, not just the next workflow stage", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        // Step 7's own instruction.
        expect(content).toMatch(
          /If all done: suggest `ce open` to review the implementation, then `\/verify` next/,
        );

        // The actual rendered completion output.
        const outputOnCompletion = content.slice(
          content.indexOf("**Output On Completion**"),
          content.indexOf("**Output On Pause"),
        );
        expect(outputOnCompletion).toMatch(
          /Review the changes with `ce open` \(opens the worktree\s*\nin your editor\), then run `\/verify` next/,
        );

        // A guardrail locks this in, matching the same convention
        // verify.md/adversarial-review.md use for their own report-open handoff.
        const guardrailsSection = content.slice(
          content.indexOf("**Guardrails**"),
          content.indexOf("**Fluid Workflow Integration**"),
        );
        expect(guardrailsSection).toMatch(
          /On completion, always suggest `ce open` alongside `\/verify`/,
        );
      });

      it("the Guardrails section states this applies for any reason implementation completed, including a post-realignment resume or an adversarial-review fix", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        const guardrailsSection = content.slice(content.indexOf("**Guardrails**"), content.indexOf("**Fluid Workflow Integration**"));
        expect(guardrailsSection).toMatch(/Never suggest `\/archive` as the next step, for any reason/);
        expect(guardrailsSection).toMatch(
          /whether from the normal task list, after realigning artifacts, or after fixing an adversarial-review finding/,
        );
      });

      it("no completion or state-handling path in this file ever tells the user to run /archive", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        // "/archive" as an actual suggested command never appears --
        // only ever named to explicitly forbid suggesting it.
        const archiveMentions = content.match(/`\/archive`/g) ?? [];
        for (const mention of archiveMentions) {
          const idx = content.indexOf(mention);
          const surrounding = content.slice(Math.max(0, idx - 40), idx);
          expect(surrounding).toMatch(/never|isn't available/i);
        }
        expect(archiveMentions.length).toBeGreaterThan(0);
      });
    });

    describe("selecting the change: prefers this workspace's own active change over project-wide discovery", () => {
      it("checks `ce status \"$CE_PROJECT/$CE_ISSUE\"` before falling back to project-wide openspec list discovery", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        expect(content).toMatch(/ce status "\$CE_PROJECT\/\$CE_ISSUE"/);
        const checkIdx = content.indexOf('ce status "$CE_PROJECT/$CE_ISSUE"');
        const fallbackIdx = content.indexOf("Only now fall back to");
        expect(checkIdx).toBeGreaterThan(-1);
        expect(fallbackIdx).toBeGreaterThan(-1);
        expect(checkIdx).toBeLessThan(fallbackIdx);
      });

      it("auto-uses a sole workspace-associated active change without asking, and only falls back to legacy discovery when ce status reports none", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        expect(content).toMatch(/Exactly one line, with a real name\*\* -- use it automatically/);
        expect(content).toMatch(/Do\s+not ask the user anything/);
        expect(content).toMatch(/`Active change:\s+\(none\)`\*\* -- this workspace has no/);
      });

      it("states the guardrail explicitly: never use project-wide discovery before checking ce status for this workspace's own change", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");

        expect(content).toMatch(
          /Never select a change via project-wide discovery \(`openspec list`\) before checking `ce status "\$CE_PROJECT\/\$CE_ISSUE"`/,
        );
      });
    });

    describe("real PR-support E2E gap: records a deterministic implementation-base marker, the sole evidence /verify's review-transition detection trusts", () => {
      const readApply = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "apply.md"), "utf8");
      };

      it("records the implementation base in Step 4, after the freshness gate passes and before any task's code changes", async () => {
        const content = await readApply();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/\*\*Record the implementation base, once, if not already recorded\.\*\*/);
        expect(content).toMatch(
          /BASE_COMMIT=\$\(git -C "\$CE_WORKTREE" rev-parse HEAD\)/,
        );
        expect(content).toMatch(
          /printf 'baseCommit: "%s"\\nrecordedAt: "%s"\\n' "\$BASE_COMMIT" "\$RECORDED_AT" \\\s*\n\s*> "<changeRoot>\/\.ce-implementation-base\.yml"/,
        );

        // Positioned inside step 4 (after the freshness gate), before step 5.
        const step4Idx = content.search(/4\. \*\*Gate on the plan's freshness/);
        const markerIdx = content.search(/Record the implementation base, once, if not already recorded/);
        const step5Idx = content.search(/^5\. \*\*Show current progress\*\*/m);
        expect(step4Idx).toBeGreaterThan(-1);
        expect(markerIdx).toBeGreaterThan(-1);
        expect(step5Idx).toBeGreaterThan(-1);
        expect(step4Idx).toBeLessThan(markerIdx);
        expect(markerIdx).toBeLessThan(step5Idx);
      });

      it("never overwrites an existing marker on a later resume -- it records the true, one-time implementation starting point", async () => {
        const content = await readApply();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /\*\*If it already exists\*\*, leave it completely untouched -- it\s*records this change's true implementation starting point from the very\s*first time `\/apply` reached this step\./,
        );
        expect(normalized).toMatch(
          /Never overwrite it on\s*a later resume: doing so would silently narrow what a later\s*`\/verify`\/`\/adversarial-review` reviews/,
        );
      });

      it("records the worktree's current HEAD, never the workspace's original CE_DIFF_BASE -- correct even when /apply started from a fresh branch off a different point in history", async () => {
        const content = await readApply();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /This is exactly `\$CE_WORKTREE`'s own current commit at this\s*moment -- never the workspace's original `\$CE_DIFF_BASE`/,
        );
        expect(normalized).toMatch(
          /the worktree may\s*already be on a completely different branch\/history by the time\s*`\/apply` runs/,
        );
      });

      it("a guardrail states this is the only deterministic evidence a transition can be trusted on -- never inferred from an OpenSpec change, a validated plan, or generic worktree divergence alone", async () => {
        const content = await readApply();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /This is the only deterministic evidence a later `\/verify`\/`\/adversarial-review` can trust that this change actually entered implementation through `\/apply` itself -- never infer implementation from an OpenSpec change merely existing, from `\/propose` having validated a plan, or from the worktree merely differing from some earlier state\./,
        );
      });

      it("never mentioned in this command's own user-facing output, matching the other ce-harness-owned sidecars", async () => {
        const content = await readApply();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /A small,\s*ce-harness-owned sidecar -- never one of the `artifacts` OpenSpec\s*tracks, never part of `applyRequires`, and never mentioned in this\s*command's own output\./,
        );
      });
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

    describe("real Oz E2E gap: completion must hand off a runnable `ce open --archived` command, never a bare filesystem path", () => {
      it("the success output's Archived to line is a ready-to-run `ce open --archived` command, not a raw path", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

        expect(content).toMatch(/\*\*Archived to:\*\* `ce open --archived <project>\/<issue>`/);
        // The old bare-path presentation must not have crept back in.
        expect(content).not.toMatch(/\*\*Archived to:\*\* the archive path derived from/);
      });

      it("explicitly forbids printing the bare archive filesystem path, and explains why (terminal click-as-URL)", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

        expect(content).toMatch(/Never print the bare archive filesystem path/);
        expect(content).toMatch(/attempts to open it\s*\n?\s*as a browser URL/);
      });

      it("instructs substituting the literal project/issue, never the raw $CE_PROJECT/$CE_ISSUE tokens", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

        expect(content).toMatch(/Substitute the\s*\n?\s*literal `<project>` and `<issue>`/);
        expect(content).toMatch(/never\s*\n?\s*print the placeholder text or the raw/);
      });

      it("still ends with Next: /publish on its own line, unchanged by the handoff fix", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

        expect(content).toMatch(/\nNext: \/publish\n/);
      });
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

    it("gates archive on durable, fresh, non-blocking evidence from /verify and /adversarial-review (Step 4, hard gate)", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");
      const normalized = content.replace(/\s+/g, " ");

      expect(content).toMatch(
        /4\. \*\*Require durable, fresh, non-blocking evidence from `\/verify` and `\/adversarial-review` \(hard gate\)\*\*/,
      );
      expect(normalized).toMatch(
        /It never runs\s*`\/verify` or `\/adversarial-review` itself, never modifies a report,\s*and never reclassifies a finding's Merge impact itself/i,
      );
      expect(normalized).toMatch(/This applies only to OpenSpec implementation changes/i);
      expect(normalized).toMatch(
        /by filename date: `\*-verify\.md` \/ `\*-adversarial-review\.md`/,
      );
      // Fingerprint covers uncommitted tracked+untracked changes, not just HEAD.
      expect(content).toMatch(/git -C "\$CE_WORKTREE" diff HEAD/);
      expect(content).toMatch(
        /git -C "\$CE_WORKTREE" ls-files --others --exclude-standard -z \| \(cd "\$CE_WORKTREE" && xargs -0 cat\)/,
      );
      // Artifacts hash covers proposal/design/tasks/specs, not just tasks.md.
      expect(content).toMatch(/for f in proposal\.md design\.md tasks\.md; do/);
      expect(content).toMatch(/find "<changeRoot>\/specs" -type f/);

      // The classifications, and that freshness is checked before merge-impact.
      expect(content).toMatch(/\*\*Missing\*\* -- no report of that kind exists at all\. Required, not/);
      expect(content).toMatch(/\*\*Failing\*\* -- its `\*\*Verdict:\*\*` line reads `FAIL`\./);
      expect(normalized).toMatch(
        /\*\*Stale\*\* -- its `\*\*Verdict:\*\*` line reads `PASS` or `PASS WITH\s*GAPS`, but its/,
      );
      expect(content).toMatch(/\*\*Fresh `PASS`\*\* -- its `\*\*Verdict:\*\*` line reads `PASS`, and both/);
      expect(content).toMatch(/\*\*Fresh `PASS WITH GAPS`\*\* -- its `\*\*Verdict:\*\*` line reads `PASS/);
      expect(normalized).toMatch(
        /\*\*If both reports are Good\*\* \(whether from a clean `PASS`, or a\s*`PASS WITH GAPS` where every unresolved item is explicitly\s*`Non-blocking`\): proceed to step 5\./,
      );
      expect(normalized).toMatch(
        /\*\*If either report is Missing, Failing, Stale, or Blocked by\s*findings: stop here\.\*\* Do not proceed to step 5 or step 6\./,
      );
    });

    it("Step 4's gate is unconditional -- no confirm-to-continue override, unlike steps 2-3's warnings", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");
      const normalized = content.replace(/\s+/g, " ");

      expect(normalized).toMatch(
        /This is unconditional -- unlike\s*steps 2 and 3's warnings, there is no "confirm to continue anyway,"/i,
      );
      expect(normalized).toMatch(
        /This command requires a fresh `\/verify` and `\/adversarial-review` report before archiving \(Step 4\), with nothing unresolved that either report itself classifies `Blocking`/i,
      );
      expect(normalized).toMatch(/no confirm-to-continue override, unlike the softer artifact\/task-completion warnings in steps 2-3/i);
      expect(normalized).toMatch(
        /A later passing rerun always supersedes an earlier failure, since the gate only ever looks at the most recent report of each kind/i,
      );
    });

    it('shows an "Archive Blocked" output naming both commands, quoting the specific blocking item, and telling the user exactly what to run next', async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");

      expect(content).toMatch(/## Archive Blocked/);
      expect(content).toMatch(/\*\*verify:\*\* <one of:/);
      expect(content).toMatch(/\*\*adversarial-review:\*\* <same shapes as above, for `\/adversarial-review <name>`/);
      expect(content).toMatch(/Missing -- run `\/verify <name>` first\./);
      expect(content).toMatch(
        /FAIL -- run `\/verify <name>` again after addressing its findings\./,
      );
      expect(content).toMatch(
        /PASS WITH GAPS, but stale \(verified against a different commit\/tasks\.md than the current state\) -- run `\/verify <name>` again\./,
      );
      expect(content).toMatch(
        /PASS WITH GAPS with an unresolved Blocking gap -- '<the gap's own text, verbatim>' -- resolve it/,
      );
      expect(content).toMatch(/Run whichever command\(s\) are needed above, then `\/archive <name>` again\./);
      // No more "unresolved review evidence" line in the success-path Warnings --
      // reaching Output On Success at all already implies Step 4 passed.
      expect(content).not.toMatch(/Unresolved review evidence: <report filename>/);
      // The gate never claims to require a literal clean PASS anymore.
      expect(content).not.toMatch(/this gate requires a clean PASS/);
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

    describe("real MAT E2E gap: archive eligibility must respect each report's Merge impact, not just its verdict token", () => {
      const readArchive = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");
      };

      it("scenario 1 -- a fresh, clean PASS from both reports is still Good and archiveable, unchanged", async () => {
        const content = await readArchive();
        const normalized = content.replace(/\s+/g, " ");

        expect(content).toMatch(/\*\*Fresh `PASS`\*\* -- its `\*\*Verdict:\*\*` line reads `PASS`, and both/);
        expect(normalized).toMatch(
          /Continue directly to \*\*Good\*\* below\s*-- a clean `PASS` has no findings\/gaps to inspect\./,
        );
      });

      it("scenario 2 -- a fresh PASS WITH GAPS containing an unresolved Blocking finding/gap is Blocked, not Good", async () => {
        const content = await readArchive();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /\*\*If any unresolved item is `Blocking` \(or untagged\):\*\* this report\s*counts as \*\*Blocked by findings\*\* -- see below\./,
        );
        expect(normalized).toMatch(
          /\*\*If either report is Missing, Failing, Stale, or Blocked by\s*findings: stop here\.\*\*/,
        );
      });

      it("scenario 3 -- a fresh PASS WITH GAPS containing only Non-blocking findings (e.g. a MINOR, high-confidence, non-blocking documentation finding) is Good and archiveable", async () => {
        const content = await readArchive();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /\*\*If every unresolved item across both checks is explicitly\s*`Non-blocking`:\*\* this report counts as \*\*Good\*\*, same as a clean\s*`PASS`/,
        );
        // Explicitly checks adversarial-review's Findings table Merge impact column,
        // not just its verdict token -- a Non-blocking MINOR finding must not block.
        expect(normalized).toMatch(
          /check every row of "Findings\s*Affecting This Change" for `Merge impact: Blocking`/,
        );
      });

      it("scenario 4 -- a fresh PASS WITH GAPS caused only by an explicitly Non-blocking environment/credential limitation (verify's Gaps and Blockers, or adversarial-review's Scope limitations/Gaps or inaccessible evidence) is Good and archiveable", async () => {
        const content = await readArchive();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /every entry under "Gaps and Blockers" must\s*carry an explicit `Merge impact: Blocking` or `Non-blocking` tag/,
        );
        expect(normalized).toMatch(
          /every entry under \*\*Scope limitations\*\* and \*\*Gaps or inaccessible\s*evidence\*\* for an explicit `Merge impact` tag/,
        );
        // An accepted gap must be surfaced, never hidden as if the run were a clean PASS.
        expect(content).toMatch(/\*\*Carried-forward gaps \(explicitly non-blocking, not required to be fixed before archiving\):\*\*/);
        expect(normalized).toMatch(
          /Never omit this\s*section, and never let the surrounding output read as if the result\s*were a clean `PASS`/,
        );
      });

      it("scenario 5 -- staleness is checked unconditionally for both PASS and PASS WITH GAPS, before merge-impact is ever considered, and always blocks", async () => {
        const content = await readArchive();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /freshness is checked\s*unconditionally, regardless of which verdict token is present, since\s*a stale report must block archive no matter how its findings are\s*classified/,
        );
        expect(normalized).toMatch(
          /Checked identically for both verdict tokens --\s*a\s*`PASS WITH GAPS` report is exactly as capable of going stale as a\s*`PASS` one, and an accepted non-blocking gap from a stale report is\s*never trustworthy evidence about the current worktree\./,
        );
        // Stale is listed as an unconditional blocker alongside Missing/Failing, distinct from findings-based blocking.
        expect(normalized).toMatch(
          /\*\*If either report is Missing, Failing, Stale, or Blocked by\s*findings: stop here\.\*\*/,
        );
      });

      it("never reclassifies a finding's Merge impact itself, and never lets a legacy/untagged item pass silently", async () => {
        const content = await readArchive();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/never reclassifies a finding's Merge impact itself/);
        expect(content).toMatch(
          /Treat any\s*entry with \*\*no tag at all\*\* \(a legacy report predating this\s*convention\) as `Blocking` -- never assume an untagged gap is safe\./,
        );
        expect(normalized).toMatch(
          /with the same\s*untagged-means-`Blocking` rule as above/,
        );
      });
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

    describe("refuses to run in an existing-PR-review workspace that has NOT transitioned to implementation", () => {
      it("checks the store/worktree guard first, then CE_DIFF_BASE/CE_DIFF_HEAD via a `ce diff-scope` reviewTransition check, and stops entirely when not detected", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ");

        const storeGuardIndex = content.search(
          /if `CE_OPENSPEC_STORE` or `CE_WORKTREE` is empty or unset, stop/i,
        );
        const reviewGuardIndex = content.search(
          /If `CE_DIFF_BASE` and `CE_DIFF_HEAD` are both set/,
        );
        expect(storeGuardIndex).toBeGreaterThan(-1);
        expect(reviewGuardIndex).toBeGreaterThan(-1);
        expect(storeGuardIndex).toBeLessThan(reviewGuardIndex);

        expect(normalized).toMatch(/ce diff-scope/);
        expect(normalized).toMatch(/reviewTransition/);
        expect(normalized).toMatch(/Do not attempt any partial verification/i);
        expect(normalized).toMatch(/Stop entirely and take no further action/i);
      });

      it("explains this workspace reviews an existing commit range, not an OpenSpec implementation, when no transition is detected", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ");

        expect(normalized).toMatch(/reviewing an existing commit range/i);
        expect(normalized).toMatch(
          /`\/verify` checks conformance against the artifacts of an OpenSpec change/i,
        );
        expect(normalized).toMatch(/only, at most,\s*auxiliary exploration\/review artifacts/i);
        expect(normalized).toMatch(
          /If you've started repairing\s*this PR via `\/propose` and `\/apply` inside this workspace, run\s*`\/apply` to completion first, then re-run `\/verify`/,
        );
      });

      it("points the user at /adversarial-review as the correct command", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`\/adversarial-review` is the correct command for reviewing the\s*external commit range directly/i,
        );
      });
    });

    describe("real PR-support E2E gap: a review workspace that transitions into implementation must not be permanently locked out of /verify", () => {
      const readVerify = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
      };

      it("a detected transition continues as an ordinary Implementation workspace, reusing the Guard's own diff-scope result", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /\*\*`\{"detected": true, "changeName": "<name>", \.\.\.\}`\*\* -- deterministic/,
        );
        expect(normalized).toMatch(
          /Continue exactly as an\s*ordinary Implementation workspace for the rest of this command,\s*verifying `<name>`\./,
        );
        expect(normalized).toMatch(
          /You already have this invocation's diff-scope\s*result from the call above -- reuse it directly in Step 3 rather than\s*calling `ce diff-scope` again\./,
        );
      });

      it("never infers a transition merely from artifacts/plan/worktree divergence -- requires the dedicated /apply-recorded implementation-base marker", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /an implementation-base marker `\/apply` itself recorded for\s*`<name>` the first time it began implementing -- something only\s*`\/apply`, and nothing else in the workflow, ever writes/,
        );
        expect(normalized).toMatch(
          /no active change owned by\s*this workspace has an implementation-base marker recorded by `\/apply`/,
        );
      });

      it("the report's Scope must disclose the transition, never leaving it indistinguishable from a workspace that started as Implementation", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /If the Guard \(Step 0\) detected a review-to-implementation transition, say so explicitly here/,
        );
        expect(normalized).toMatch(
          /never let this look indistinguishable from a workspace that started as an\s*Implementation workspace\./,
        );
      });

      it("Step 3 also notes reusing Step 0's diff-scope result instead of recomputing it", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /If Step 0 already called `ce diff-scope`\s*to detect a review-to-implementation transition, you already have this\s*exact JSON output -- reuse it directly instead of calling it again/,
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

    describe("diff-scope resolution (delegated to `ce diff-scope`)", () => {
      it("resolves the diff range via `ce diff-scope` instead of restating the algorithm inline", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).toContain("ce diff-scope");
        // Explicit mode: three-dot for the diff, two-dot for the log.
        expect(content).toMatch(/"mode": "explicit"/);
        expect(content).toMatch(/diffRange.*\(three-dot\) for the diff and `logRange` \(two-dot\) for the commit log/s);
        // Merge-base fallback and the no-base scope-limitation case are both still handled.
        expect(content).toMatch(/"mode": "merge-base"/);
        expect(content).toMatch(/"mode": "no-base"/);
        expect(content).toMatch(/falling back to `main`\/`master` only when/);
        // The old inline algorithm must not have crept back in.
        expect(content).not.toMatch(/LOCAL_MB=|ORIGIN_MB=|BASE_MB=/);
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

    describe("real MAT E2E gap: a command exiting 0 with warnings must not present as silent clean success", () => {
      const readVerify = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
      };

      it("'Handling large output' requires preserving tool-reported warnings even on a 0 exit code, and excludes them from the 'noise that may be omitted' allowance", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Always preserve\s*\*\*every warning the tool itself reported, even when the\s*command exits 0\*\*/,
        );
        expect(normalized).toMatch(
          /Never fold\s*a tool-reported warning into this "noise" category just because the\s*command still exited 0/,
        );
      });

      it("the 'Commands Executed and Outcomes' entry format has a Warnings line, and states it never by itself changes PASS/FAIL/BLOCKED", async () => {
        const content = await readVerify();
        const section = content.slice(
          content.indexOf("## Commands Executed and Outcomes"),
          content.indexOf("## Gaps and Blockers"),
        );

        expect(section).toMatch(/Warnings: <verbatim warning line\(s\)/);
        expect(section.replace(/\s+/g, " ")).toMatch(
          /A PASS with warnings listed here is still PASS: recording a warning here never by itself changes this command's own PASS\/FAIL\/BLOCKED status or the Overall Verdict below\./,
        );
      });

      it("the PASS verdict definition explicitly says a command exiting 0 with recorded warnings still counts as PASS, and names the deferred (not-yet-built) classification work", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /A command that exits 0 but reported warnings \(see "Commands Executed\s*and Outcomes" above\) still counts as PASS here/,
        );
        expect(normalized).toMatch(
          /classifying them \(e\.g\. distinguishing one\s*introduced by this change from a pre-existing one, or ever escalating\s*a warning to `PASS WITH GAPS`\/`FAIL` on its own\) is deliberately out\s*of scope for this version\./,
        );
      });

      it("a guardrail reinforces that a 0 exit code is never license to drop warnings, without turning them into a blocking result", async () => {
        const content = await readVerify();
        const guardrailsSection = content.slice(content.indexOf("**Guardrails**"));
        const normalized = guardrailsSection.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /An exit code of 0 is never license to drop a command's warnings --/,
        );
        expect(normalized).toMatch(
          /Recording it there never by itself changes that\s*command's PASS\/FAIL\/BLOCKED status or the Overall Verdict/,
        );
      });
    });

    it("carries no leading HTML comment, trailing provenance essay, or THIRD_PARTY_NOTICES.md pointer -- this is the author's own original work, confirmed to have no third-party source (see THIRD_PARTY_NOTICES.md's 'Provenance correction')", async () => {
      const { readFile } = await import("node:fs/promises");
      const { templatesRoot } = await import("../../src/core/templates.js");
      const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

      expect(content).not.toMatch(/<!--/);
      expect(content).not.toMatch(/_Provenance:/);
      expect(content).not.toMatch(/market-audit-tool/i);
      expect(content).not.toMatch(/verify-against-spec/i);
      expect(content).not.toMatch(/THIRD_PARTY_NOTICES\.md/);
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

    describe("durable verdict and staleness fields (for /archive's hard gate)", () => {
      const readVerify = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
      };

      it("resolves and records the current worktree fingerprint and artifacts hash before writing the report", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(content).toMatch(/git -C "\$CE_WORKTREE" rev-parse HEAD/);
        // Fingerprint: HEAD + uncommitted tracked diff + untracked file content.
        expect(content).toMatch(/git -C "\$CE_WORKTREE" diff HEAD/);
        expect(content).toMatch(
          /git -C "\$CE_WORKTREE" ls-files --others --exclude-standard -z \| \(cd "\$CE_WORKTREE" && xargs -0 cat\) 2>\/dev\/null/,
        );
        // Artifacts hash: proposal/design/tasks/specs, not just tasks.md.
        expect(content).toMatch(/for f in proposal\.md design\.md tasks\.md; do/);
        expect(content).toMatch(/find "<changeRoot>\/specs" -type f 2>\/dev\/null \| sort \| xargs cat/);
        expect(normalized).toMatch(
          /`\/archive` later uses these three values to\s*detect whether this evidence has gone stale/i,
        );
        expect(normalized).toMatch(
          /record `N\/A -- no\s*artifacts to hash` for the artifacts hash instead of running that\s*command/i,
        );
      });

      it("writes the recorded fingerprint/hash into the report header, and a machine-checkable Verdict sentinel", async () => {
        const content = await readVerify();

        expect(content).toMatch(/\*\*Verified worktree commit:\*\* <full SHA -- human reference only>/);
        expect(content).toMatch(
          /\*\*Verified worktree fingerprint:\*\* <12-char hash covering the commit plus any uncommitted tracked\/untracked implementation changes>/,
        );
        expect(content).toMatch(
          /\*\*Verified artifacts hash:\*\* <12-char hash covering proposal\.md\/design\.md\/tasks\.md\/specs\/, or "N\/A -- no artifacts to hash">/,
        );
        expect(content).toMatch(/^\*\*Verdict:\*\* PASS$/m);
      });

      it("instructs never renaming, reformatting, or double-tokening the Verdict sentinel line", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Write `\*\*Verdict:\*\*` followed by exactly one of `PASS`, `PASS WITH\s*GAPS`, or `FAIL` -- nothing else on that line\./,
        );
        expect(normalized).toMatch(
          /so never rename it, reformat it, or leave more\s*than one token on it\./,
        );
      });
    });

    describe("next-step guidance is conditional on the verdict, and never suggests /archive", () => {
      const readVerify = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
      };

      it("a clean PASS recommends /adversarial-review next", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`PASS` -- run `\/adversarial-review` next for independent defect hunting\./,
        );
      });

      it("PASS WITH GAPS or FAIL recommends fixing findings and re-running /verify, never proceeding to /adversarial-review or /archive", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`PASS WITH GAPS` or `FAIL` -- address the findings above first \(via\s*`\/apply` or a manual fix\), then re-run `\/verify` -- do not proceed to\s*`\/adversarial-review` on a report that isn't a clean `PASS`\./,
        );
      });

      it("never suggests /archive from this command, deferring entirely to /archive's own gate", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /never `\/archive` from this\s*command either way, that is entirely `\/archive`'s own gate to decide/,
        );
        // "/archive" as an actual suggested command never appears in
        // Report back -- only ever named to explain it's out of scope.
        const reportBack = content.slice(
          content.indexOf("## 10. Report back"),
          content.indexOf("**Guardrails**"),
        );
        const archiveMentions = reportBack.match(/`\/archive`/g) ?? [];
        expect(archiveMentions.length).toBeGreaterThan(0);
        for (const mention of archiveMentions) {
          const idx = reportBack.indexOf(mention);
          const surrounding = reportBack.slice(Math.max(0, idx - 30), idx);
          expect(surrounding).toMatch(/never/i);
        }
      });
    });

    describe("real UX blocker (E2E), same fix applied here: the report-back handoff gives an actionable ce open --path command, not just a bare filesystem path", () => {
      const readVerify = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
      };

      it("Step 10 instructs printing a ready-to-run `ce open --path \"<report path>\"` command, substituting the literal Step-9-resolved path", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        const reportBack = content.slice(
          content.indexOf("## 10. Report back"),
          content.indexOf("**Guardrails**"),
        );
        expect(reportBack).toContain('ce open --path "<the exact report path resolved in Step 9>"');
        expect(normalized).toMatch(
          /Substitute the literal, already-resolved absolute path from Step 9 --\s*never a placeholder, and never the store's root or the change's whole\s*directory/,
        );
      });

      it("keeps the printed report path as a reference, but states it must never be the only way offered to reach the report", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/tell the user its exact path \(inside the/);
        expect(normalized).toMatch(
          /remains useful as a\s*reference \(e\.g\. to paste elsewhere\), but must never be the only way\s*offered to reach the/,
        );
      });

      it("a guardrail requires the ce open --path command on every report, not just the printed path, and never a directory or --change in its place", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Never end Step 10 with only the report's printed filesystem path --\s*always also give the user a ready-to-run `ce open --path "<report\s*path>"` command for that exact file/,
        );
        expect(normalized).toMatch(
          /Never substitute a directory, the\s*store root, or `ce open --change` for this -- the command must open\s*the exact report file just written\./,
        );
      });
    });

    describe("real MAT E2E gap: Gaps and Blockers need a Merge impact tag so archive eligibility isn't tied to a literal clean PASS", () => {
      const readVerify = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
      };

      it("the report template requires a Merge impact tag on every Gaps and Blockers entry", async () => {
        const content = await readVerify();

        expect(content).toMatch(
          /- <unverified\/blocked item, unchecked task, or scope limitation, and why> -- \*\*Merge impact:\*\* Blocking \/ Non-blocking/,
        );
      });

      it("Blocking is the stated default, and Non-blocking requires a concrete stated reason (e.g. an unavailable external credential the requirement was otherwise confirmed despite)", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/\*\*`Blocking` is always the default\.\*\*/);
        expect(normalized).toMatch(
          /Mark a gap `Non-blocking`\s*only when you can state a concrete reason the requirement is still\s*adequately supported despite it/,
        );
        expect(normalized).toMatch(
          /an unavailable\s*credential\/service outside this change's control/,
        );
      });

      it("an UNVERIFIED CHECKBOX or a genuinely unresolved PARTIALLY VERIFIED item is always Blocking -- never downgraded merely to avoid re-verifying", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /An `UNVERIFIED CHECKBOX`, or a\s*`PARTIALLY VERIFIED` item where what's missing could plausibly mean the\s*requirement isn't actually met, is always `Blocking` -- never mark one\s*`Non-blocking` merely to avoid re-running verification\./,
        );
      });

      it("this classification never changes the verdict token itself, and the PASS WITH GAPS definition says archive eligibility depends on it, not the token alone", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /This\s*classification never changes the verdict token itself \(below\) -- it\s*only tells `\/archive` which gaps it may treat as accepted and which it\s*must still block on\./,
        );
        expect(normalized).toMatch(
          /This verdict token alone does not determine archive\s*eligibility -- `\/archive`'s own gate reads each gap's Merge impact\s*directly, not just this token/,
        );
      });

      it("a guardrail requires the tag on every entry and defaults an untagged (legacy) entry to Blocking", async () => {
        const content = await readVerify();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Every "Gaps and Blockers" entry must end with an explicit \*\*Merge\s*impact: Blocking\*\* or \*\*Non-blocking\*\* tag/,
        );
        expect(normalized).toMatch(
          /`\/archive`'s gate treats any\s*entry with no tag at all \(a legacy report predating this convention\)\s*as `Blocking`, never as safe by omission\./,
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

    describe("diff-scope resolution (delegated to `ce diff-scope`)", () => {
      it("resolves the diff range via `ce diff-scope` instead of restating the algorithm inline", async () => {
        const content = await readTemplate();

        expect(content).toContain("ce diff-scope");
        expect(content).toMatch(/"mode": "explicit"/);
        expect(content).toMatch(/diffRange.*\(three-dot\) for the diff and `logRange` \(two-dot\) for the commit log/s);
        expect(content).toMatch(/"mode": "merge-base"/);
        expect(content).toMatch(/"mode": "no-base"/);
        expect(content).toMatch(/falling back to `main`\/`master` only when/);
        expect(content).not.toMatch(/LOCAL_MB=|ORIGIN_MB=|BASE_MB=/);
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
        // the report body. It's written as a machine-checkable `**Verdict:**`
        // sentinel line, not a bare token, so /archive can grep it.
        expect(content).toMatch(/^\*\*Verdict:\*\* PASS$/m);
      });

      it("the Verdict sentinel line is machine-checkable: labeled, exactly one token, and instructed never to be reformatted", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Write `\*\*Verdict:\*\*` followed by exactly one of `PASS`, `PASS WITH\s*GAPS`, or `FAIL` -- nothing else on that line\./,
        );
        expect(normalized).toMatch(
          /This is a durable,\s*machine-checkable field: `\/archive` greps it verbatim to decide whether\s*this evidence is good, so never rename it, reformat it, or leave more\s*than one token on it\./,
        );
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
      it("detects the workspace type from CE_DIFF_BASE/CE_DIFF_HEAD before resolving anything, but only after checking for a review-to-implementation transition", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/Detect the workspace type before anything else\./);
        expect(normalized).toMatch(
          /If `CE_DIFF_BASE` and `CE_DIFF_HEAD`\s*\*are\* both set, this workspace was\s*created to review an existing, already-given commit range -- but that\s*alone never decides the type/,
        );
        expect(normalized).toMatch(/ce diff-scope/);
        expect(normalized).toMatch(
          /\*\*`null` or `\{"detected": false, \.\.\.\}`\*\* -- no active change owned by\s*this workspace has an implementation-base marker recorded by `\/apply`\s*\(see below\)\. This is an \*\*Existing PR review\*\* workspace/,
        );
        expect(normalized).toMatch(
          /\*\*`\{"detected": true, "changeName": "<name>", \.\.\.\}`\*\* -- deterministic\s*evidence.*shows this workspace has\s*transitioned from review into implementation\. Treat this as an\s*\*\*Implementation workspace\*\* for the rest of this command/,
        );
        // The detection guidance appears before "## 1. Resolve the review scope".
        const guardIndex = content.search(/Detect the workspace type before anything else/i);
        const step1Index = content.search(/^## 1\. Resolve the review scope/m);
        expect(guardIndex).toBeGreaterThan(-1);
        expect(step1Index).toBeGreaterThan(-1);
        expect(guardIndex).toBeLessThan(step1Index);
      });

      it("never infers a transition merely from artifacts/plan/worktree divergence -- requires the dedicated /apply-recorded implementation-base marker", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Never infer the type any other way -- in particular, never treat the mere\s*existence of an OpenSpec change, a validated `\/propose` plan, or a\s*worktree that merely differs from the original PR head as implementation\s*on its own/,
        );
        expect(normalized).toMatch(
          /`reviewTransition` requires the dedicated implementation-base marker\s*`\/apply` itself writes/,
        );
      });

      it("Step 5 notes reusing Step 0's diff-scope result instead of recomputing it", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /If Step 0 already called `ce diff-scope`\s*to detect a review-to-implementation transition, you already have this\s*exact JSON output -- reuse it directly instead of calling it again/,
        );
      });

      it("the report's Scope must disclose a detected transition, never leaving it indistinguishable from a workspace that started as Implementation", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /if Step 0 detected a review-to-implementation transition, say so explicitly here/,
        );
        expect(normalized).toMatch(
          /never leaving this indistinguishable from a workspace that started as an\s*Implementation workspace/,
        );
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

    describe("durable verdict and staleness fields (for /archive's hard gate)", () => {
      const readAdversarialReview = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "adversarial-review.md"), "utf8");
      };

      it("resolves and records the current worktree fingerprint and artifacts hash before writing the report (Implementation workspaces)", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(content).toMatch(/git -C "\$CE_WORKTREE" rev-parse HEAD/);
        expect(content).toMatch(/git -C "\$CE_WORKTREE" diff HEAD/);
        expect(content).toMatch(
          /git -C "\$CE_WORKTREE" ls-files --others --exclude-standard -z \| \(cd "\$CE_WORKTREE" && xargs -0 cat\) 2>\/dev\/null/,
        );
        expect(content).toMatch(/for f in proposal\.md design\.md tasks\.md; do/);
        expect(content).toMatch(/find "<changeRoot>\/specs" -type f 2>\/dev\/null \| sort \| xargs cat/);
        expect(normalized).toMatch(
          /`\/archive` later uses these three values to detect\s*whether this evidence has gone stale/i,
        );
      });

      it("skips the fingerprint/hash fields entirely for an Existing PR review workspace, which has no changeRoot", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /An Existing PR review workspace has no `changeRoot` at all\s*\(there is no OpenSpec change, so no `\/archive` gate ever applies to it\)/i,
        );
        expect(content).toMatch(
          /\*\*Reviewed worktree commit:\*\* <full SHA -- human reference only> -- Implementation workspaces only/,
        );
        expect(content).toMatch(
          /\*\*Reviewed worktree fingerprint:\*\* <12-char hash covering the commit plus any uncommitted tracked\/untracked implementation changes> -- Implementation workspaces only/,
        );
        expect(content).toMatch(
          /\*\*Reviewed artifacts hash:\*\* <12-char hash covering proposal\.md\/design\.md\/tasks\.md\/specs\/, or "N\/A -- no artifacts to hash"> -- Implementation workspaces only/,
        );
      });

      it("writes a machine-checkable Verdict sentinel and instructs never renaming, reformatting, or double-tokening it", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(content).toMatch(/^\*\*Verdict:\*\* PASS$/m);
        expect(normalized).toMatch(
          /Write `\*\*Verdict:\*\*` followed by exactly one of `PASS`, `PASS WITH\s*GAPS`, or `FAIL` -- nothing else on that line\./,
        );
        expect(normalized).toMatch(
          /so never rename it, reformat it, or leave more\s*than one token on it\./,
        );
      });
    });

    describe("next-step guidance is conditional on the verdict, and never asserts /archive is ready on its own", () => {
      const readAdversarialReview = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "adversarial-review.md"), "utf8");
      };

      it("FAIL or PASS WITH GAPS recommends fixing findings then re-running /verify -- not /archive, and not another /adversarial-review first", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`PASS WITH GAPS` or `FAIL` -- the findings above need addressing \(via\s*`\/apply` or a manual fix\) before this change can be archived\. Once\s*fixed, re-run `\/verify` next -- not `\/archive`, and not another\s*`\/adversarial-review` first -- since the implementation will have\s*changed and any existing verify evidence would be stale\./,
        );
      });

      it("a clean PASS recommends /archive only conditionally, on /verify's own report also being fresh and clean", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`PASS` \(adversarial\) -- if `\/verify`'s most recent report is also a\s*clean, fresh `PASS`, `\/archive` is available next; if not, or you are\s*unsure, run `\/verify` first\./,
        );
        expect(normalized).toMatch(
          /this command only ever suggests, never guarantees, that\s*archiving will succeed/,
        );
      });

      it('previously had no next-step guidance at all -- confirms the "Report back" section now states one explicitly', async () => {
        const content = await readAdversarialReview();

        const reportBack = content.slice(
          content.indexOf("## 10. Report back"),
          content.indexOf("**Guardrails**"),
        );
        expect(reportBack).toMatch(/State the next step based on the verdict/);
      });
    });

    describe("real UX blocker (E2E): the report-back handoff gives an actionable ce open --path command, not just a bare filesystem path", () => {
      const readAdversarialReview = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "adversarial-review.md"), "utf8");
      };

      it("Step 10 instructs printing a ready-to-run `ce open --path \"<report path>\"` command, substituting the literal Step-9-resolved path", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        const reportBack = content.slice(
          content.indexOf("## 10. Report back"),
          content.indexOf("**Guardrails**"),
        );
        expect(reportBack).toContain('ce open --path "<the exact report path resolved in Step 9>"');
        expect(normalized).toMatch(
          /Substitute the literal, already-resolved absolute path from Step 9 --\s*never a placeholder, and never the store's root or a change's whole\s*directory/,
        );
      });

      it("explains this works for both workspace types, since ce open --path resolves against the store, not the worktree, and requires no editor-specific knowledge in this command", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /This\s*works identically for both workspace types \(`ce open --path` resolves\s*against the trusted OpenSpec store, not the worktree\), requires no\s*runner- or editor-specific knowledge in this command/,
        );
      });

      it("keeps the printed report path as a reference, but states it must never be the only way offered to reach the report", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/tell the user its exact path \(inside the/);
        expect(normalized).toMatch(
          /remains useful as a\s*reference \(e\.g\. to paste elsewhere\), but must never be the only way\s*offered to reach the report\./,
        );
      });

      it("a guardrail requires the ce open --path command on every report, not just the printed path, and never a directory or --change in its place", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Never end Step 10 with only the report's printed filesystem path --\s*always also give the user a ready-to-run `ce open --path "<report\s*path>"` command for that exact file/,
        );
        expect(normalized).toMatch(
          /Never substitute a directory, the\s*store root, or `ce open --change` for this -- the command must open\s*the exact report file just written\./,
        );
      });
    });

    describe("real MAT E2E gap: Scope limitations/Gaps or inaccessible evidence need a Merge impact tag, same as a finding's", () => {
      const readAdversarialReview = async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        return readFile(join(templatesRoot(), "commands", "adversarial-review.md"), "utf8");
      };

      it("the report header's Scope limitations field and Baseline Review Coverage's Gaps or inaccessible evidence field both require a Merge impact tag", async () => {
        const content = await readAdversarialReview();

        expect(content).toMatch(
          /\*\*Scope limitations:\*\* <limitations, each ending with \*\*Merge impact:\*\* Blocking or Non-blocking, or "None declared">/,
        );
        expect(content).toMatch(
          /- \*\*Gaps or inaccessible evidence:\*\* <anything that could not be checked and why, each ending with \*\*Merge impact:\*\* Blocking or Non-blocking, or "None">/,
        );
      });

      it("the verdict is derived from the Findings table plus these two limitation fields, each requiring its own explicit Merge impact tag with the same Blocking-by-default discipline as a finding", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /The verdict is derived \*\*only\*\* from the "Findings Affecting This Change"\s*table plus the \*\*Scope limitations\*\* and \*\*Gaps or inaccessible\s*evidence\*\* fields/,
        );
        expect(normalized).toMatch(
          /using the exact same discipline as a finding's\s*Merge impact.*: `Blocking` by\s*default; `Non-blocking` only when you can state a concrete reason/,
        );
      });

      it("PASS WITH GAPS can arise from a limitation field alone, and explicitly says this doesn't by itself determine archive eligibility", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`PASS WITH GAPS` -- no `Blocking` findings affecting this change, but\s*at least one `Non-blocking` finding, or at least one \*\*Scope\s*limitations\*\*\/\*\*Gaps or inaccessible evidence\*\* entry, remains\./,
        );
        expect(normalized).toMatch(
          /This\s*verdict token alone does not determine archive eligibility --\s*`\/archive`'s own gate reads each finding's and each limitation's Merge\s*impact directly, not just this token\./,
        );
      });

      it("a clean PASS requires both limitation fields to be empty, not just an empty Findings table", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /`PASS` \(adversarial\) -- no `Blocking` or `Non-blocking` findings\s*affecting this change; \*\*Scope limitations\*\* and \*\*Gaps or\s*inaccessible evidence\*\* are both empty/,
        );
      });

      it("a guardrail requires the tag on every limitation entry and defaults an untagged (legacy) entry to Blocking", async () => {
        const content = await readAdversarialReview();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(
          /Every \*\*Scope limitations\*\* and \*\*Gaps or inaccessible evidence\*\* entry\s*must end with an explicit \*\*Merge impact: Blocking\*\* or \*\*Non-blocking\*\*\s*tag/,
        );
        expect(normalized).toMatch(
          /`\/archive`'s gate\s*treats an untagged entry \(a legacy report predating this convention\) as\s*`Blocking`, never as safe by omission\./,
        );
      });
    });
  });

  describe("Runner selection (--runner)", () => {
    let fakeClaude: FakeClaudeEnv;

    beforeEach(async () => {
      fakeClaude = await setupFakeClaude();
    });

    afterEach(async () => {
      await teardownFakeClaude(fakeClaude);
    });

    // `startCommand`'s OWN fallback (via `resolveRunner(undefined)`) is
    // still "opencode" -- this test exercises exactly that, by calling
    // `startCommand` directly, which is what every test in this suite
    // does. It does NOT exercise the real `ce start` CLI's default,
    // which cliMain.ts's `--runner` option now sets to "claude" before
    // `startCommand` is ever called -- see the black-box coverage of
    // that in test/unit/cliBuildArtifact.test.ts, and
    // core/runners/index.ts's doc comments for why these two defaults
    // deliberately differ.
    it("startCommand's own fallback (bypassing the CLI's --runner default) is still OpenCode, and persists runner: \"opencode\"", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.runner).toBe("opencode");
      expect(existsSync(fakeOpenCode.outputFile)).toBe(true);
      expect(existsSync(fakeClaude.outputFile)).toBe(false);
    });

    it('--runner claude launches Claude Code (not OpenCode) and persists runner: "claude"', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.runner).toBe("claude");
      expect(existsSync(fakeOpenCode.outputFile)).toBe(false);

      const { readFile } = await import("node:fs/promises");
      const launch = JSON.parse(await readFile(fakeClaude.outputFile, "utf8"));
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect(launch.cwd).toBe(await realpathOf(worktreePath));
      expect(launch.argv).toEqual([]);
    });

    it("rejects an unknown --runner before creating any persistent resource, listing supported runner ids", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      const { CeError } = await import("../../src/core/errors.js");

      try {
        await startCommand({ repo: repoDir, issue: "issue-1", runner: "cursor" });
        expect.fail("expected startCommand to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CeError);
        const ceError = error as InstanceType<typeof CeError>;
        expect(ceError.message).toMatch(/Unknown runner "cursor"/);
        expect(ceError.recovery).toContain("opencode");
        expect(ceError.recovery).toContain("claude");
      }

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout.trim()).toBe("");
    });

    it("provisions <worktree>/.claude/commands from the canonical templates for Claude, without leaving any tracked change in the target repository", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { templatesRoot } = await import("../../src/core/templates.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const copiedPath = join(workspace.worktreePath, ".claude", "commands", "workspace.md");
      const sourcePath = join(templatesRoot(), "commands", "workspace.md");
      expect(existsSync(copiedPath)).toBe(true);
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));

      // The canonical workflow's own promise (see "OpenCode external
      // configuration" above) holds for Claude too: no tracked change
      // appears in the worktree's real, unfiltered `git status`, and
      // nothing at all appears in the original repository.
      const status = await execa("git", ["-C", workspace.worktreePath, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
      expect(existsSync(join(repoDir, ".claude"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
    });

    it("propagates Claude Code's exit code as ce's own exit code", async () => {
      process.env.FAKE_CLAUDE_EXIT_CODE = "4";
      try {
        const { startCommand } = await import("../../src/commands/start.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

        expect(process.exitCode).toBe(4);
      } finally {
        delete process.env.FAKE_CLAUDE_EXIT_CODE;
      }
    });

    describe("pre-existing .claude/ safety (Q1/Q2/Q3/Q4 follow-up)", () => {
      it('a repository whose base branch already tracks a colliding ".claude/commands/workspace.md" is never clobbered, and every other command still installs', async () => {
        const { mkdir: mkdirP, writeFile, readFile } = await import("node:fs/promises");
        await mkdirP(join(repoDir, ".claude", "commands"), { recursive: true });
        await writeFile(
          join(repoDir, ".claude", "commands", "workspace.md"),
          "the repository's own tracked command\n",
          "utf8",
        );
        await execa("git", ["-C", repoDir, "add", "."]);
        await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .claude/commands/workspace.md"]);

        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

        const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
        const commandsManaged = workspace.runnerWorktreeArtifacts?.commandsManaged;
        expect(Array.isArray(commandsManaged)).toBe(true);
        expect(commandsManaged).not.toContain(join("commands", "workspace.md"));
        // The collision costs only the one colliding file -- every other
        // command still installs alongside the repository's own.
        expect(commandsManaged).toContain(join("commands", "adversarial-review.md"));

        // Untouched: the repository's own command survives, and
        // ce-harness's own workspace.md was never mixed in alongside it.
        expect(
          await readFile(join(workspace.worktreePath, ".claude", "commands", "workspace.md"), "utf8"),
        ).toBe("the repository's own tracked command\n");
        expect(
          existsSync(join(workspace.worktreePath, ".claude", "commands", "adversarial-review.md")),
        ).toBe(true);

        const status = await execa("git", ["-C", workspace.worktreePath, "status", "--porcelain"]);
        expect(status.stdout).toBe("");
        expect(
          errorSpy.mock.calls.some(
            (call) => String(call[0]).includes("already exists") && String(call[0]).includes("/workspace"),
          ),
        ).toBe(true);
      });

      it('the Oz scenario: a repository tracking only an unrelated ".claude/skills/setup-service-infra/" still gets every ce-harness command and skill installed, /adversarial-review included, and cleanup succeeds WITHOUT --force', async () => {
        const { mkdir: mkdirP, writeFile, readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const ownSkillDir = join(repoDir, ".claude", "skills", "setup-service-infra");
        await mkdirP(ownSkillDir, { recursive: true });
        await writeFile(join(ownSkillDir, "SKILL.md"), "the repository's own skill\n", "utf8");
        await execa("git", ["-C", repoDir, "add", "."]);
        await execa("git", ["-C", repoDir, "commit", "-m", "vendor a setup-service-infra skill"]);

        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        const { cleanupCommand } = await import("../../src/commands/cleanup.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        // vi.spyOn reuses (rather than replaces) an already-mocked
        // console.error across tests in this file, so mockClear() here
        // guarantees this test only sees calls it caused itself.
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        errorSpy.mockClear();

        await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

        const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
        const commandsManaged = workspace.runnerWorktreeArtifacts?.commandsManaged;
        expect(Array.isArray(commandsManaged)).toBe(true);
        // Zero collisions: nothing about setup-service-infra's name
        // matches any ce-harness template, so nothing was skipped.
        expect(
          errorSpy.mock.calls.some((call) => String(call[0]).includes("setup-service-infra")),
        ).toBe(false);
        expect(errorSpy).not.toHaveBeenCalled();

        // /adversarial-review is materialized...
        const adversarialReviewPath = join(
          workspace.worktreePath,
          ".claude",
          "commands",
          "adversarial-review.md",
        );
        expect(existsSync(adversarialReviewPath)).toBe(true);
        expect(await readFile(adversarialReviewPath, "utf8")).toBe(
          await readFile(join(templatesRoot(), "commands", "adversarial-review.md"), "utf8"),
        );
        // ...alongside every other ce-harness command...
        for (const command of ["explore", "enrich", "propose", "apply", "verify", "archive", "workspace"]) {
          expect(existsSync(join(workspace.worktreePath, ".claude", "commands", `${command}.md`))).toBe(
            true,
          );
        }
        // ...and ce-harness's own skill.
        expect(
          existsSync(join(workspace.worktreePath, ".claude", "skills", "openspec-sync-specs", "SKILL.md")),
        ).toBe(true);

        // setup-service-infra remains untouched.
        expect(
          await readFile(join(workspace.worktreePath, ".claude", "skills", "setup-service-infra", "SKILL.md"), "utf8"),
        ).toBe("the repository's own skill\n");

        const status = await execa("git", ["-C", workspace.worktreePath, "status", "--porcelain"]);
        expect(status.stdout).toBe("");

        // Cleanup removes only ce-harness-owned artifacts: the dirty
        // check passes without --force even though the repository's own
        // tracked skill still sits inside .claude alongside them.
        await expect(cleanupCommand({})).resolves.not.toThrow();
        expect(existsSync(workspace.worktreePath)).toBe(false);
      });

      it("cleanup still requires --force when an untracked, non-harness-owned file sits alongside harness-managed .claude/ content", async () => {
        const { startCommand } = await import("../../src/commands/start.js");
        const { readWorkspace } = await import("../../src/core/workspace.js");
        const { cleanupCommand } = await import("../../src/commands/cleanup.js");
        const { CeError } = await import("../../src/core/errors.js");
        const { writeFile } = await import("node:fs/promises");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });
        const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

        // Never written by ce-harness -- some unrelated file that
        // happens to land under .claude/ mid-session. Deliberately not
        // named "settings.local.json": that exact path is a common
        // global-gitignore convention for personal Claude Code settings,
        // which would make this test depend on the machine's own global
        // Git config instead of ce-harness's own exclusion logic.
        await writeFile(join(workspace.worktreePath, ".claude", "unrelated-note.txt"), "hi\n", "utf8");

        // Per-item ownership tracking means this unrelated file is never
        // swept into the harness-managed exclusion -- cleanup must still
        // treat it as a real change and refuse without --force.
        await expect(cleanupCommand({})).rejects.toThrow(CeError);
        expect(existsSync(workspace.worktreePath)).toBe(true);

        await expect(cleanupCommand({ force: true })).resolves.not.toThrow();
      });

      it('ce cleanup succeeds WITHOUT --force after a fresh --runner claude start writes .claude/ and .mcp.json (CodeGraph available)', async () => {
        const { setupFakeCodeGraph, teardownFakeCodeGraph } = await import("../helpers/fakeCodeGraph.js");
        delete process.env.CE_CODEGRAPH_BIN;
        setupFakeCodeGraph();
        try {
          const { startCommand } = await import("../../src/commands/start.js");
          const { readWorkspace } = await import("../../src/core/workspace.js");
          vi.spyOn(console, "log").mockImplementation(() => undefined);

          await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

          const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
          const commandsManaged = workspace.runnerWorktreeArtifacts?.commandsManaged;
          expect(Array.isArray(commandsManaged)).toBe(true);
          expect((commandsManaged as string[]).length).toBeGreaterThan(0);
          expect(workspace.runnerWorktreeArtifacts?.mcpManaged).toBe(true);
          expect(existsSync(join(workspace.worktreePath, ".claude"))).toBe(true);
          expect(existsSync(join(workspace.worktreePath, ".mcp.json"))).toBe(true);

          // The real, unfiltered `git status` is clean -- both paths were
          // added to the local exclude file -- so cleanup needs no --force.
          const status = await execa("git", ["-C", workspace.worktreePath, "status", "--porcelain"]);
          expect(status.stdout).toBe("");

          const { cleanupCommand } = await import("../../src/commands/cleanup.js");
          await expect(cleanupCommand({})).resolves.not.toThrow();
          expect(existsSync(workspace.worktreePath)).toBe(false);
        } finally {
          teardownFakeCodeGraph();
          process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
        }
      });
    });
  });
});

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
