import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
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

describe("ce resume (integration)", () => {
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
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
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
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("refuses with an actionable message when there is no active workspace", async () => {
    const { resumeCommand } = await import("../../src/commands/resume.js");
    const { CeError } = await import("../../src/core/errors.js");

    try {
      await resumeCommand();
      expect.fail("expected resumeCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toBe("No active workspace.");
      expect(ceError.recovery).toMatch(/ce start <repo> <issue>/);
    }
  });

  it("relaunches OpenCode with exactly the same environment ce start used, and never mutates workspace metadata", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    const { readWorkspace, readActivePointer } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspaceFileContentBefore = await readFile(
      join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1", "workspace.yml"),
      "utf8",
    );
    const activePointerBefore = await readActivePointer();
    const startLaunch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));

    // Simulate OpenCode having exited: the workspace stays active, we just
    // relaunch into it.
    await resumeCommand();

    const resumeLaunch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
    expect(resumeLaunch.cwd).toBe(startLaunch.cwd);
    expect(resumeLaunch.env).toEqual(startLaunch.env);

    const workspaceFileContentAfter = await readFile(
      join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1", "workspace.yml"),
      "utf8",
    );
    expect(workspaceFileContentAfter).toBe(workspaceFileContentBefore);

    const activePointerAfter = await readActivePointer();
    expect(activePointerAfter).toEqual(activePointerBefore);

    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
    expect(existsSync(workspace.worktreePath)).toBe(true);
  });

  it("prints a resuming message identifying the workspace", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await resumeCommand();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(new RegExp(`Resuming workspace for project "${basenameOf(repoDir)}", issue "issue-1"`));
  });

  it("never creates a worktree, workspace, OpenSpec store, or CodeGraph index, and never touches the original repository", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    const registryBefore = await readFile(fakeOpenSpec.registryFile, "utf8");
    const worktreeHeadBefore = (
      await execa("git", ["-C", worktreePath, "rev-parse", "HEAD"])
    ).stdout.trim();
    const repoBranchesBefore = (
      await execa("git", ["-C", repoDir, "branch", "--list"])
    ).stdout.trim();

    await resumeCommand();

    const registryAfter = await readFile(fakeOpenSpec.registryFile, "utf8");
    expect(registryAfter).toBe(registryBefore);

    const worktreeHeadAfter = (
      await execa("git", ["-C", worktreePath, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(worktreeHeadAfter).toBe(worktreeHeadBefore);

    const repoBranchesAfter = (
      await execa("git", ["-C", repoDir, "branch", "--list"])
    ).stdout.trim();
    expect(repoBranchesAfter).toBe(repoBranchesBefore);

    expect(existsSync(join(worktreePath, ".codegraph"))).toBe(false);
    expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
  });

  it("refuses when the recorded worktree is missing, identifying project/issue and recommending ce cleanup --force", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    await rm(worktreePath, { recursive: true, force: true });

    try {
      await resumeCommand();
      expect.fail("expected resumeCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(new RegExp(`project "${basenameOf(repoDir)}", issue "issue-1"`));
      expect(ceError.message).toMatch(/Worktree not found at/);
      expect(ceError.message).toContain(worktreePath);
      expect(ceError.recovery).toMatch(/ce cleanup --force/);
    }

    // Never silently repaired: the worktree is still gone.
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("refuses when the recorded workspace directory (and its workspace.yml) is missing", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
    await rm(workspacePath, { recursive: true, force: true });

    try {
      await resumeCommand();
      expect.fail("expected resumeCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(new RegExp(`project "${basenameOf(repoDir)}", issue "issue-1"`));
      expect(ceError.message).toMatch(/metadata could not be read/);
      expect(ceError.recovery).toMatch(/ce cleanup --force/);
    }

    expect(existsSync(workspacePath)).toBe(false);
  });

  it("refuses when the persisted OpenSpec metadata is corrupt/tampered (doesn't cross-validate)", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    const { readWorkspace, writeWorkspace } = await import("../../src/core/workspace.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
    await writeWorkspace({
      ...workspace,
      openSpec: { storeId: "ce-tampered-0000000000", root: workspace.openSpec!.root },
    });

    try {
      await resumeCommand();
      expect.fail("expected resumeCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/corrupt or tampered/);
      expect(ceError.recovery).toMatch(/ce cleanup --force/);
    }
  });

  it("reports a launch failure with a manual-entry recovery command, built from the same shared launch env", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1" });

    process.env.CE_OPENCODE_BIN = nonExistentOpenCodeBin(fakeOpenCode.dir);

    try {
      await resumeCommand();
      expect.fail("expected resumeCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/Failed to launch OpenCode/);
      expect(ceError.recovery).toMatch(/Enter the workspace manually with/);
      expect(ceError.recovery).toContain("CE_WORKSPACE=");
      expect(ceError.recovery).toContain("CE_WORKTREE=");
    } finally {
      delete process.env.CE_OPENCODE_BIN;
    }
  });

  it("propagates OpenCode's exit code as ce's own exit code", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1" });

    process.env.FAKE_OPENCODE_EXIT_CODE = "7";
    try {
      await resumeCommand();
      expect(process.exitCode).toBe(7);
    } finally {
      delete process.env.FAKE_OPENCODE_EXIT_CODE;
    }
  });

  it("reuses the shared launch-env implementation: an explicit --base/--head workspace resumes with CE_DIFF_BASE/CE_DIFF_HEAD intact", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
    await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
    await writeFile(join(repoDir, "feature.txt"), "new feature\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "feature commit"]);
    const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
    await execa("git", ["-C", repoDir, "checkout", "main"]);

    await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: headSha });

    await resumeCommand();

    const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
    expect(launch.env.CE_DIFF_BASE).toBe(baseSha);
    expect(launch.env.CE_DIFF_HEAD).toBe(headSha);
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
