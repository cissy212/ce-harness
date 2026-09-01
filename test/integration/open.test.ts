import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
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
import { nonExistentOsascriptBin } from "../helpers/fakeOsascript.js";
import {
  nonExistentEditorBin,
  setupFakeEditor,
  teardownFakeEditor,
  type FakeEditorEnv,
} from "../helpers/fakeEditor.js";

describe("ce open (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  let fakeOpenCode: FakeOpenCodeEnv;
  let fakeEditor: FakeEditorEnv;
  const originalEnv = process.env.CE_HARNESS_HOME;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
    fakeOpenSpec = await setupFakeOpenSpec();
    fakeOpenCode = await setupFakeOpenCode();
    fakeEditor = await setupFakeEditor();
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
    await teardownFakeEditor(fakeEditor);
    delete process.env.CE_CODEGRAPH_BIN;
    delete process.env.CE_OSASCRIPT_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("refuses with an actionable message when there is no active workspace", async () => {
    const { openCommand } = await import("../../src/commands/open.js");
    const { CeError } = await import("../../src/core/errors.js");

    try {
      await openCommand();
      expect.fail("expected openCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toBe("No active workspace.");
      expect(ceError.recovery).toMatch(/ce start <repo> <issue>/);
    }
  });

  it("opens the active workspace's worktree with a single command, with no manual path lookup", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { openCommand } = await import("../../src/commands/open.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

    await openCommand();

    const recorded = JSON.parse(await readFile(fakeEditor.outputFile, "utf8"));
    expect(recorded.argv).toEqual([workspace.worktreePath]);
  });

  it("never creates, registers, or modifies anything -- purely opens the existing worktree", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { openCommand } = await import("../../src/commands/open.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspaceFile = join(
      harnessHomeDir,
      "workspaces",
      basenameOf(repoDir),
      "issue-1",
      "workspace.yml",
    );
    const contentBefore = await readFile(workspaceFile, "utf8");
    const registryBefore = await readFile(fakeOpenSpec.registryFile, "utf8");

    await openCommand();

    const contentAfter = await readFile(workspaceFile, "utf8");
    const registryAfter = await readFile(fakeOpenSpec.registryFile, "utf8");
    expect(contentAfter).toBe(contentBefore);
    expect(registryAfter).toBe(registryBefore);
  });

  it("prints which worktree it is opening, and in which editor", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { openCommand } = await import("../../src/commands/open.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();
    await openCommand();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain(workspace.worktreePath);
    expect(output).toMatch(/VS Code/);
  });

  it("refuses when the recorded worktree is missing, identifying project/issue and recommending ce cleanup --force", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { openCommand } = await import("../../src/commands/open.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    await rm(worktreePath, { recursive: true, force: true });

    try {
      await openCommand();
      expect.fail("expected openCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(new RegExp(`project "${basenameOf(repoDir)}", issue "issue-1"`));
      expect(ceError.message).toMatch(/its worktree is missing/);
      expect(ceError.recovery).toContain(worktreePath);
      expect(ceError.recovery).toMatch(/ce cleanup --force/);
    }

    // Never silently repaired: the worktree is still gone.
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("refuses when the recorded workspace directory (and its workspace.yml) is missing", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { openCommand } = await import("../../src/commands/open.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
    await rm(workspacePath, { recursive: true, force: true });

    try {
      await openCommand();
      expect.fail("expected openCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(new RegExp(`project "${basenameOf(repoDir)}", issue "issue-1"`));
      expect(ceError.message).toMatch(/metadata could not be read/);
      expect(ceError.recovery).toMatch(/ce cleanup --force/);
    }
  });

  it("reports a launch failure with a manual-entry recovery command", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { openCommand } = await import("../../src/commands/open.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

    process.env.CE_EDITOR_BIN = nonExistentEditorBin(fakeEditor.dir);

    try {
      await openCommand();
      expect.fail("expected openCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/Failed to open the workspace in VS Code/);
      expect(ceError.recovery).toMatch(/Open it manually with/);
      expect(ceError.recovery).toContain(workspace.worktreePath);
    }
  });

  it("propagates a non-zero editor exit as a clear error, never silently succeeding", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { openCommand } = await import("../../src/commands/open.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    process.env.FAKE_EDITOR_EXIT_CODE = "1";
    process.env.FAKE_EDITOR_STDERR = "code: command failed\n";

    await expect(openCommand()).rejects.toThrow(CeError);
    await expect(openCommand()).rejects.toThrow(/Failed to open the workspace in VS Code/);
  });

  it("works identically for a workspace created via ce review (Existing PR review workspace)", async () => {
    const { execa } = await import("execa");
    const { writeFile } = await import("node:fs/promises");
    const { openCommand } = await import("../../src/commands/open.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const { startCommand } = await import("../../src/commands/start.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
    await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
    await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "feature"]);
    const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
    await execa("git", ["-C", repoDir, "checkout", "main"]);

    await startCommand({ repo: repoDir, issue: "review-pr-1", base: baseSha, head: headSha });
    const workspace = await readWorkspace(basenameOf(repoDir), "review-pr-1");

    await openCommand();

    const recorded = JSON.parse(await readFile(fakeEditor.outputFile, "utf8"));
    expect(recorded.argv).toEqual([workspace.worktreePath]);
  });

  describe("--change (opens the OpenSpec change's artifacts instead of the worktree)", () => {
    async function trustedRoot(): Promise<string> {
      const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
        "../../src/core/workspace.js"
      );
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace);
      return trusted!.root;
    }

    it("auto-resolves and opens the sole active change when --change is given with no name", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const changeRoot = join(root, "openspec", "changes", "contacts-email-notes");
      await mkdir(changeRoot, { recursive: true });

      await openCommand({ change: true });

      const recorded = JSON.parse(await readFile(fakeEditor.outputFile, "utf8"));
      expect(recorded.argv).toEqual([changeRoot]);
    });

    it("opens a specific active change by name, ignoring other active changes", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      await mkdir(join(root, "openspec", "changes", "alpha-change"), { recursive: true });
      const betaRoot = join(root, "openspec", "changes", "beta-change");
      await mkdir(betaRoot, { recursive: true });

      await openCommand({ change: "beta-change" });

      const recorded = JSON.parse(await readFile(fakeEditor.outputFile, "utf8"));
      expect(recorded.argv).toEqual([betaRoot]);
    });

    it("refuses with an actionable message when there is no active change to open", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      await expect(openCommand({ change: true })).rejects.toThrow(CeError);
      await expect(openCommand({ change: true })).rejects.toThrow(/No active OpenSpec change to open/);
    });

    it("refuses and lists every active change when more than one exists and no name was given", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      await mkdir(join(root, "openspec", "changes", "alpha-change"), { recursive: true });
      await mkdir(join(root, "openspec", "changes", "beta-change"), { recursive: true });

      try {
        await openCommand({ change: true });
        expect.fail("expected openCommand to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CeError);
        const ceError = error as InstanceType<typeof CeError>;
        expect(ceError.message).toMatch(/Multiple active OpenSpec changes exist/);
        expect(ceError.recovery).toContain("alpha-change");
        expect(ceError.recovery).toContain("beta-change");
        expect(ceError.recovery).toMatch(/ce open --change <name>/);
      }
    });

    it("refuses with the list of active changes when the named change doesn't exist", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      await mkdir(join(root, "openspec", "changes", "alpha-change"), { recursive: true });

      try {
        await openCommand({ change: "does-not-exist" });
        expect.fail("expected openCommand to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CeError);
        const ceError = error as InstanceType<typeof CeError>;
        expect(ceError.message).toMatch(/No active OpenSpec change named "does-not-exist"/);
        expect(ceError.recovery).toContain("alpha-change");
      }
    });

    it("prints which change it is opening, distinct from the worktree-opening message", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      await mkdir(join(root, "openspec", "changes", "contacts-email-notes"), { recursive: true });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      await openCommand({ change: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Opening change "contacts-email-notes"/);
      expect(output).toMatch(/VS Code/);
    });

    it("never creates, registers, or modifies anything -- purely opens the existing change directory", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      await mkdir(join(root, "openspec", "changes", "contacts-email-notes"), { recursive: true });

      const workspaceFile = join(
        harnessHomeDir,
        "workspaces",
        basenameOf(repoDir),
        "issue-1",
        "workspace.yml",
      );
      const contentBefore = await readFile(workspaceFile, "utf8");

      await openCommand({ change: true });

      const contentAfter = await readFile(workspaceFile, "utf8");
      expect(contentAfter).toBe(contentBefore);
    });
  });

  describe("targeting a specific workspace ([workspace] argument)", () => {
    it("opens the requested non-default workspace's worktree, never the default one", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const worktree130 = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-130");
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);

      await openCommand({ workspace: `${project}/issue-130` });

      const recorded = JSON.parse(await readFile(fakeEditor.outputFile, "utf8"));
      expect(recorded.argv).toEqual([worktree130]);
    });

    it("never changes which workspace is the default, even when a workspace is targeted explicitly", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);

      await openCommand({ workspace: `${project}/issue-130` });

      expect(await readActivePointer()).toEqual({ project, sanitizedIssue: "issue-143" });
    });

    it("refuses with an actionable, listed error when the targeted workspace doesn't exist", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { openCommand } = await import("../../src/commands/open.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const project = basenameOf(repoDir);

      try {
        await openCommand({ workspace: `${project}/no-such-issue` });
        expect.fail("expected openCommand to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CeError);
        const ceError = error as InstanceType<typeof CeError>;
        expect(ceError.message).toMatch(/No workspace found for/);
        expect(ceError.recovery).toContain(`${project}/issue-1`);
      }
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
