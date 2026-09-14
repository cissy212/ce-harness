import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { nonExistentOsascriptBin } from "../helpers/fakeOsascript.js";
import { deregisterWorktreeBookkeeping } from "../helpers/deregisterWorktree.js";

// This file exercises `ce status --verbose` -- the full, low-level detail
// this command showed unconditionally before a concise, human-oriented
// default was introduced. See the "ce status (concise default output)"
// and "ce status --all" describe blocks near the end of this file for the
// newer behavior.
describe("ce status --verbose (integration)", () => {
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
    delete process.env.CE_OSASCRIPT_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("prints a clear message when there is no active workspace", async () => {
    const { statusCommand } = await import("../../src/commands/status.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await statusCommand({ verbose: true });

    expect(logSpy).toHaveBeenCalledWith("No active workspace.");
  });

  it("reports full details for the active workspace, including a clean worktree", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { statusCommand } = await import("../../src/commands/status.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await statusCommand({ verbose: true });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Issue:\s+issue-1/);
    expect(output).toMatch(/Base branch:\s+main/);
    expect(output).toMatch(/Internal branch:\s+ce-harness\/issue-1/);
    expect(output).toMatch(/Worktree exists:\s+yes/);
    expect(output).toMatch(/Branch exists:\s+yes/);
    expect(output).toMatch(/Worktree changes:\s+clean/);
    expect(output).toMatch(/OpenSpec store:\s+ce-/);
    expect(output).toMatch(/OpenSpec root:\s+.+\/openspec\/.+$/m);
    expect(output).toMatch(/OpenSpec durable:\s+yes/);
    expect(output).toMatch(/OpenSpec healthy:\s+yes/);
    expect(output).toMatch(/OpenCode config:\s+.+\/opencode$/m);
    expect(output).toMatch(/OpenCode config exists:\s+yes/);
    expect(output).toMatch(/Lenses dir:\s+.+\/lenses$/m);
    expect(output).toMatch(/Lenses dir exists:\s+yes/);
    expect(output).not.toMatch(/Review base:/);
    expect(output).not.toMatch(/Review head:/);
    expect(output).not.toMatch(/Review merge base:/);
  });

  it("reports changed files when the worktree has been modified", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { statusCommand } = await import("../../src/commands/status.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    await writeFile(join(worktreePath, "new-file.txt"), "changed\n", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await statusCommand({ verbose: true });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Worktree changes:\s+1 changed file\(s\)/);
  });

  describe("orphaned worktree (directory exists, but Git no longer registers it)", () => {
    it("reports the orphaned state clearly instead of crashing", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

      // Exactly the state a partially-failed `git worktree remove`
      // leaves behind: Git's own bookkeeping is gone, but the directory
      // (and whatever real content it still has) survives. Constructed
      // deterministically here -- no Docker, no macOS ACL involved.
      await deregisterWorktreeBookkeeping(repoDir, worktreePath);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await expect(statusCommand({ verbose: true })).resolves.toBeUndefined();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Worktree exists:\s+yes/);
      expect(output).toMatch(/Worktree registered:\s+no \(orphaned\)/);
      expect(output).toMatch(/Worktree changes:\s+orphaned/i);
      expect(output).toMatch(/no longer registers it/i);
    });

    it("never attempts a plain `git status` against the orphaned directory (it would fail outright)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      await deregisterWorktreeBookkeeping(repoDir, worktreePath);

      // Confirms the premise: a real `git status` here really would
      // fail outright, which is exactly why statusCommand must not run
      // one -- this is what used to crash `ce status`.
      const { execa } = await import("execa");
      const rawStatus = await execa("git", ["-C", worktreePath, "status", "--porcelain"], {
        reject: false,
      });
      expect(rawStatus.exitCode).not.toBe(0);

      await expect(statusCommand({ verbose: true })).resolves.toBeUndefined();
    });

    it("a normal, still-registered worktree is unaffected by this check", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).not.toMatch(/Worktree registered:/);
      expect(output).toMatch(/Worktree changes:\s+clean/);
    });
  });

  describe("OpenSpec status", () => {
    it("is read-only and reports unhealthy without touching the workspace when doctor reports a problem", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      process.env.FAKE_OPENSPEC_FAIL_DOCTOR = "1";
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/OpenSpec healthy:\s+no/);

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect((await import("node:fs")).existsSync(worktreePath)).toBe(true);
    });

    it("reports 'unavailable' when the store was manually unregistered", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { unregisterStore } = await import("../../src/core/openspec.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      await unregisterStore(workspace.workspacePath, workspace.openSpec!.storeId);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/OpenSpec healthy:\s+no/);
    });

    it("reports 'unavailable' (without crashing) when the openspec executable cannot be run", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      process.env.CE_OPENSPEC_BIN = nonExistentOpenSpecBin(fakeOpenSpec.dir);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await expect(statusCommand({ verbose: true })).resolves.toBeUndefined();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/OpenSpec healthy:\s+unavailable/);
    });

    it("omits OpenSpec lines entirely for a legacy (v0.1) workspace file", async () => {
      const { statusCommand } = await import("../../src/commands/status.js");
      const { writeActivePointer } = await import("../../src/core/workspace.js");
      const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
        "../../src/core/paths.js"
      );

      const project = basenameOf(repoDir);
      const worktreePath = buildWorktreePath(project, "issue-1");
      const workspacePath = buildWorkspacePath(project, "issue-1");
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

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).not.toMatch(/OpenSpec/);
    });
  });

  describe("OpenCode config status", () => {
    it("reports the config directory and exists:yes right after start", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(
        new RegExp(`OpenCode config:\\s+${join(workspace.workspacePath, "opencode").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      expect(output).toMatch(/OpenCode config exists:\s+yes/);
      expect(output).toMatch(
        new RegExp(`Lenses dir:\\s+${join(workspace.workspacePath, "lenses").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      expect(output).toMatch(/Lenses dir exists:\s+yes/);
    });

    it("reports exists:no (without crashing) for a legacy workspace with no OpenCode config directory", async () => {
      const { statusCommand } = await import("../../src/commands/status.js");
      const { writeActivePointer } = await import("../../src/core/workspace.js");
      const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
        "../../src/core/paths.js"
      );

      const project = basenameOf(repoDir);
      const worktreePath = buildWorktreePath(project, "issue-1");
      const workspacePath = buildWorkspacePath(project, "issue-1");
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

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await expect(statusCommand({ verbose: true })).resolves.toBeUndefined();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/OpenCode config:\s+.+\/opencode$/m);
      expect(output).toMatch(/OpenCode config exists:\s+no/);
      expect(output).toMatch(/Lenses dir:\s+.+\/lenses$/m);
      expect(output).toMatch(/Lenses dir exists:\s+no/);
      expect(output).not.toMatch(/Review base:/);
      expect(output).not.toMatch(/Review head:/);
      expect(output).not.toMatch(/Review merge base:/);
    });
  });

  describe("Review base/head status", () => {
    it("shows Review base/head/merge base only for a workspace with an explicit review range", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { execa } = await import("execa");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "feature.txt"), "new feature\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "feature commit"]);
      const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: headSha });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(new RegExp(`Review base:\\s+${workspace.diffBase}`));
      expect(output).toMatch(new RegExp(`Review head:\\s+${workspace.diffHead}`));
      expect(output).toMatch(new RegExp(`Review merge base:\\s+${workspace.diffMergeBase}`));
    });

    it("omits Review base/head/merge base entirely for a legacy workspace with no diff fields", async () => {
      const { statusCommand } = await import("../../src/commands/status.js");
      const { writeActivePointer } = await import("../../src/core/workspace.js");
      const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
        "../../src/core/paths.js"
      );

      const project = basenameOf(repoDir);
      const worktreePath = buildWorktreePath(project, "issue-1");
      const workspacePath = buildWorkspacePath(project, "issue-1");
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

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await expect(statusCommand({ verbose: true })).resolves.toBeUndefined();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).not.toMatch(/Review base:/);
      expect(output).not.toMatch(/Review head:/);
      expect(output).not.toMatch(/Review merge base:/);
    });
  });

  describe("Workspace type reporting", () => {
    it('reports "Workspace type: Implementation" for the default flow', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Workspace type:\s+Implementation/);
      expect(output).not.toMatch(/Existing PR review/);
    });

    it('reports "Workspace type: Existing PR review" for an explicit --base/--head workspace', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { execa } = await import("execa");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "feature.txt"), "new feature\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "feature commit"]);
      const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "feature"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "issue-1", base: baseSha, head: headSha });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Workspace type:\s+Existing PR review/);
    });
  });

  describe("Active OpenSpec change and artifacts", () => {
    async function trustedRoot(): Promise<string> {
      const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
        "../../src/core/workspace.js"
      );
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace);
      return trusted!.root;
    }

    it('reports "Active change: (none)" when no change has been created yet', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+\(none\)/);
      expect(output).not.toMatch(/View artifacts:/);
    });

    it("shows a single active change with its artifact checklist and how to view it", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();

      await mkdir(join(root, "openspec", "changes", "contacts-email-notes"), { recursive: true });
      await writeFile(
        join(root, "openspec", "changes", "contacts-email-notes", "explore.md"),
        "findings\n",
        "utf8",
      );
      await writeFile(
        join(root, "openspec", "changes", "contacts-email-notes", "enrich.md"),
        "**Status:** ready\n",
        "utf8",
      );
      await writeFile(
        join(root, "openspec", "changes", "contacts-email-notes", "proposal.md"),
        "why\n",
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+contacts-email-notes/);
      expect(output).toMatch(/Artifacts:\s+explore ✓\s+enrich ✓ \(ready\)\s+proposal ✓\s+design ✗\s+tasks ✗/);
      expect(output).toMatch(/View artifacts:\s+ce open --change\s*$/m);
    });

    it("lists every active change when more than one exists, and suggests naming one to open", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();

      await mkdir(join(root, "openspec", "changes", "alpha-change"), { recursive: true });
      await mkdir(join(root, "openspec", "changes", "beta-change"), { recursive: true });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+alpha-change/);
      expect(output).toMatch(/Active change:\s+beta-change/);
      expect(output).toMatch(/View artifacts:\s+ce open --change <name>\s*$/m);
    });

    it("excludes archived changes from the active-change section", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();

      await mkdir(join(root, "openspec", "changes", "archive", "2026-05-12-add-user-auth"), {
        recursive: true,
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+\(none\)/);
      expect(output).not.toMatch(/add-user-auth/);
    });

    it("shows specs and reports counts when a change has delta specs and reports", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();

      await mkdir(
        join(root, "openspec", "changes", "contacts-email-notes", "specs", "contacts-directory"),
        { recursive: true },
      );
      await writeFile(
        join(root, "openspec", "changes", "contacts-email-notes", "specs", "contacts-directory", "spec.md"),
        "delta\n",
        "utf8",
      );
      await mkdir(join(root, "openspec", "changes", "contacts-email-notes", "reports"), {
        recursive: true,
      });
      await writeFile(
        join(root, "openspec", "changes", "contacts-email-notes", "reports", "2026-05-12-verify.md"),
        "report\n",
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/specs \(1: contacts-directory\)/);
      expect(output).toMatch(/reports \(1\)/);
    });
  });

  describe("Provenance (planning-artifact staleness against the current worktree)", () => {
    async function trustedRoot(): Promise<string> {
      const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
        "../../src/core/workspace.js"
      );
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace);
      return trusted!.root;
    }

    it("omits the Provenance line entirely when no planning artifact exists yet", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).not.toMatch(/Provenance:/);
    });

    it("shows the Provenance line as \"unknown\" (never omitted, never treated as fresh) for a change whose artifacts exist but predate provenance tracking (no sidecar)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      await mkdir(join(root, "openspec", "changes", "contacts-email-notes"), { recursive: true });
      await writeFile(
        join(root, "openspec", "changes", "contacts-email-notes", "explore.md"),
        "findings\n",
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+contacts-email-notes/);
      expect(output).toMatch(/Provenance:\s+explore unknown \(no provenance recorded -- legacy\) -- rerun \/explore/);
    });

    it('reports "fresh" for a stage whose recorded fingerprint matches the current worktree', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { computeWorktreeFingerprint } = await import("../../src/core/git.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const changeDir = join(root, "openspec", "changes", "contacts-email-notes");
      await mkdir(changeDir, { recursive: true });
      await writeFile(join(changeDir, "explore.md"), "findings\n", "utf8");

      const fingerprint = await computeWorktreeFingerprint(workspace.worktreePath);
      await writeFile(
        join(changeDir, ".ce-provenance-explore.yml"),
        `commit: "abc123"\nfingerprint: "${fingerprint}"\nrecordedAt: "2026-09-01"\n`,
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Provenance:\s+explore fresh \(as of 2026-09-01\)/);
    });

    it('reports "stale" once the worktree changes after a stage was recorded', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const changeDir = join(root, "openspec", "changes", "contacts-email-notes");
      await mkdir(changeDir, { recursive: true });
      await writeFile(join(changeDir, "explore.md"), "findings\n", "utf8");
      await writeFile(
        join(changeDir, ".ce-provenance-explore.yml"),
        'commit: "abc123"\nfingerprint: "000000000000"\nrecordedAt: "2026-08-20"\n',
        "utf8",
      );

      // Worktree has moved on since that (fabricated, deliberately
      // non-matching) fingerprint was recorded.
      await writeFile(join(workspace.worktreePath, "new-file.txt"), "x\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Provenance:\s+explore stale \(repo changed since 2026-08-20\)/);
    });

    it("reports each present stage independently on the same Provenance line", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { computeWorktreeFingerprint } = await import("../../src/core/git.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const changeDir = join(root, "openspec", "changes", "contacts-email-notes");
      await mkdir(changeDir, { recursive: true });
      await writeFile(join(changeDir, "explore.md"), "findings\n", "utf8");
      await writeFile(join(changeDir, "proposal.md"), "why\n", "utf8");

      const fingerprint = await computeWorktreeFingerprint(workspace.worktreePath);
      await writeFile(
        join(changeDir, ".ce-provenance-explore.yml"),
        `commit: "a"\nfingerprint: "${fingerprint}"\nrecordedAt: "2026-09-01"\n`,
        "utf8",
      );
      await writeFile(
        join(changeDir, ".ce-provenance-propose.yml"),
        'commit: "b"\nfingerprint: "000000000000"\nrecordedAt: "2026-08-15"\n',
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/explore fresh \(as of 2026-09-01\)/);
      expect(output).toMatch(/propose stale \(repo changed since 2026-08-15\)/);
    });

    it("real #138 smoke scenario: ce status \"$CE_PROJECT/$CE_ISSUE\" (the exact invocation /propose now uses) auto-resolves the workspace's own active change AND surfaces its legacy/unknown explore provenance, in one call, with no interaction needed", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      const project = basenameOf(repoDir);

      // Exactly what /propose (step 3) and /explore (step 8) already
      // produce for a real change: an ownership-tagged change with an
      // explore.md that predates provenance tracking (no sidecar at
      // all) -- the exact #138 smoke state.
      const changeDir = join(root, "openspec", "changes", "consolidate-drawer-base-component");
      await mkdir(changeDir, { recursive: true });
      await writeFile(
        join(changeDir, ".ce-workspace.yml"),
        `project: "${project}"\nissue: "issue-1"\n`,
        "utf8",
      );
      await writeFile(join(changeDir, "explore.md"), "findings\n", "utf8");
      await writeFile(join(changeDir, "enrich.md"), "**Status:** ready\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      // The exact command propose.md's step 1 now runs, using
      // $CE_PROJECT/$CE_ISSUE (here: workspace.project/workspace.issue,
      // the same raw values CE_PROJECT/CE_ISSUE are set to).
      await statusCommand({ workspace: `${workspace.project}/${workspace.issue}`, verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      // 1. The change name is resolved automatically -- no ambiguity,
      //    nothing for an agent to ask the user about.
      expect(output).toMatch(/Active change:\s+consolidate-drawer-base-component/);
      // 2 & 3. Its explore provenance is unknown (legacy) and the exact
      //    corrective action is named -- everything /propose's gate
      //    needs to stop and direct the user to /explore, without a
      //    second round-trip.
      expect(output).toMatch(/Provenance:\s+explore unknown \(no provenance recorded -- legacy\) -- rerun \/explore/);
    });
  });

  describe("workspace -> active change association", () => {
    async function trustedRootFor(project: string, sanitizedIssue: string): Promise<string> {
      const { readWorkspace, resolveTrustedOpenSpec } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(project, sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace);
      return trusted!.root;
    }

    /** Mirrors what /propose's ownership sidecar step writes. */
    async function tagChange(
      root: string,
      name: string,
      project: string,
      issue: string,
    ): Promise<string> {
      const changeRoot = join(root, "openspec", "changes", name);
      await mkdir(changeRoot, { recursive: true });
      await writeFile(
        join(changeRoot, ".ce-workspace.yml"),
        `project: "${project}"\nissue: "${issue}"\n`,
        "utf8",
      );
      return changeRoot;
    }

    it("reports each workspace's own associated change, even though both share the same durable store", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);
      const root = await trustedRootFor(project, "issue-130");
      await tagChange(root, "fix-contact-empty-state", project, "issue-130");
      await tagChange(root, "add-billing-export", project, "issue-143");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-130`, verbose: true });
      let output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+fix-contact-empty-state/);
      expect(output).not.toMatch(/add-billing-export/);

      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-143`, verbose: true });
      output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+add-billing-export/);
      expect(output).not.toMatch(/fix-contact-empty-state/);
    });

    it("three preserved workspaces (mirroring real #130/#143/#138), each with its own tagged active change: ce status for one never leaks another's -- exactly the command /enrich, /propose, and /apply now run", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      await startCommand({ repo: repoDir, issue: "issue-138" });
      const project = basenameOf(repoDir);
      const root = await trustedRootFor(project, "issue-130");
      await tagChange(root, "fix-contact-empty-state", project, "issue-130");
      await tagChange(root, "add-billing-export", project, "issue-143");
      await tagChange(root, "consolidate-drawer-base-component", project, "issue-138");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      // The exact invocation the fixed templates now run:
      // `ce status "$CE_PROJECT/$CE_ISSUE"`.
      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-138`, verbose: true });
      let output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+consolidate-drawer-base-component/);
      expect(output).not.toMatch(/fix-contact-empty-state/);
      expect(output).not.toMatch(/add-billing-export/);

      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-130`, verbose: true });
      output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+fix-contact-empty-state/);
      expect(output).not.toMatch(/consolidate-drawer-base-component/);
      expect(output).not.toMatch(/add-billing-export/);

      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-143`, verbose: true });
      output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+add-billing-export/);
      expect(output).not.toMatch(/consolidate-drawer-base-component/);
      expect(output).not.toMatch(/fix-contact-empty-state/);
    });

    it("explicit read-only targeting never switches the default workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);
      const root = await trustedRootFor(project, "issue-130");
      await tagChange(root, "fix-contact-empty-state", project, "issue-130");
      await tagChange(root, "add-billing-export", project, "issue-143");

      await statusCommand({ workspace: `${project}/issue-130`, verbose: true });

      expect(await readActivePointer()).toEqual({ project, sanitizedIssue: "issue-143" });
    });

    it("a legacy workspace/change with no ownership sidecar still reports safely", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRootFor(basenameOf(repoDir), "issue-1");
      await mkdir(join(root, "openspec", "changes", "legacy-change"), { recursive: true });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+legacy-change/);
    });

    it("never leaks another workspace's associated change when this workspace has none of its own", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);
      const root = await trustedRootFor(project, "issue-130");
      await tagChange(root, "add-billing-export", project, "issue-143");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-130`, verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+\(none\)/);
      expect(output).not.toMatch(/add-billing-export/);
    });

    it("keeps a legacy workspace's untagged change usable after a different, newer workspace starts tagging its own (mixed legacy + tagged store)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);
      const root = await trustedRootFor(project, "issue-130");
      // issue-130's change predates the association mechanism: no sidecar.
      await mkdir(join(root, "openspec", "changes", "legacy-change"), { recursive: true });
      // issue-143's change is newer and tagged.
      await tagChange(root, "add-billing-export", project, "issue-143");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-130`, verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+legacy-change/);
      expect(output).not.toMatch(/add-billing-export/);
    });
  });

  describe("targeting a specific workspace ([workspace] argument), and the Other workspaces list", () => {
    it("shows the requested non-default workspace's detail, never changing which is the default", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-130`, verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Issue:\s+issue-130/);
      expect(await readActivePointer()).toEqual({ project, sanitizedIssue: "issue-143" });
    });

    it("lists every other preserved workspace under Other workspaces when more than one exists", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Issue:\s+issue-143/);
      expect(output).toMatch(/Other workspaces:/);
      expect(output).toMatch(new RegExp(`${project}/issue-130`));
    });

    it("omits the Other workspaces section entirely when only one workspace exists", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      logSpy.mockClear();
      await statusCommand({ verbose: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).not.toMatch(/Other workspaces:/);
    });

    it("refuses with an actionable, listed error when the targeted workspace doesn't exist", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const project = basenameOf(repoDir);

      await expect(statusCommand({ workspace: `${project}/no-such-issue`, verbose: true })).rejects.toThrow(CeError);
      await expect(statusCommand({ workspace: `${project}/no-such-issue`, verbose: true })).rejects.toThrow(
        /No workspace found for/,
      );
    });
  });

  describe("ce status (concise default output)", () => {
    async function trustedRoot(): Promise<string> {
      const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
        "../../src/core/workspace.js"
      );
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace);
      return trusted!.root;
    }

    async function currentWorktreePath(): Promise<string> {
      const { readActivePointer, readWorkspace } = await import("../../src/core/workspace.js");
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      return workspace.worktreePath;
    }

    /**
     * Records a *fresh* provenance stamp for `stage`, matching the
     * worktree's current fingerprint -- the state a real `/explore`,
     * `/enrich`, or `/propose` run leaves behind. Used so a test can
     * exercise a *later* workflow stage without every earlier one being
     * reported as invalid for having no provenance at all (exactly the
     * "never treat unknown as fresh" gate the templates themselves
     * enforce -- see core/provenance.ts).
     */
    async function writeFreshProvenance(
      changeRoot: string,
      stage: "explore" | "enrich" | "propose",
    ): Promise<void> {
      const { computeWorktreeFingerprint } = await import("../../src/core/git.js");
      const worktreePath = await currentWorktreePath();
      const fingerprint = await computeWorktreeFingerprint(worktreePath);
      const filenames = {
        explore: ".ce-provenance-explore.yml",
        enrich: ".ce-provenance-enrich.yml",
        propose: ".ce-provenance-propose.yml",
      };
      await writeFile(
        join(changeRoot, filenames[stage]),
        `commit: "${"0".repeat(40)}"\nfingerprint: "${fingerprint}"\nrecordedAt: "2026-01-01"\n`,
        "utf8",
      );
    }

    it("shows the four essentials -- project, issue, type, worktree -- with no active change", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Project:\s+/);
      expect(output).toMatch(/Issue:\s+issue-1/);
      expect(output).toMatch(/Type:\s+Implementation/);
      expect(output).toMatch(/Worktree:\s+clean/);
      expect(output).toMatch(/Active change:\s+\(none\)/);
      expect(output).toMatch(/Next step:\s+\/explore \(or \/propose if you already know what to build\)/);
    });

    it("never shows internal implementation/debug detail by default", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).not.toMatch(/Repository path:/);
      expect(output).not.toMatch(/Worktree path:/);
      expect(output).not.toMatch(/Workspace path:/);
      expect(output).not.toMatch(/Internal branch:/);
      expect(output).not.toMatch(/Base commit:/);
      expect(output).not.toMatch(/Created at:/);
      expect(output).not.toMatch(/OpenSpec store:/);
      expect(output).not.toMatch(/OpenSpec root:/);
      expect(output).not.toMatch(/Project id:/);
      expect(output).not.toMatch(/Identity evidence:/);
      expect(output).not.toMatch(/OpenCode config:/);
      expect(output).not.toMatch(/Lenses dir:/);
      // No full 40-char SHA appears anywhere.
      expect(output).not.toMatch(/\b[0-9a-f]{40}\b/);
    });

    it("shows progress and suggests /enrich once explore exists but enrich/propose don't", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const changeRoot = join(root, "openspec", "changes", "add-contact-notes");
      await mkdir(changeRoot, { recursive: true });
      await writeFile(join(changeRoot, "explore.md"), "findings\n", "utf8");
      await writeFreshProvenance(changeRoot, "explore");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+add-contact-notes/);
      expect(output).toMatch(/Progress:\s+explore ✓\s+enrich ✗\s+proposal ✗\s+design ✗\s+tasks ✗/);
      expect(output).toMatch(/Next step:\s+\/enrich/);
      expect(output).not.toMatch(/Needs attention:/);
    });

    it("surfaces stale planning-artifact provenance as attention, and suggests rerunning exactly that stage", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const changeRoot = join(root, "openspec", "changes", "add-contact-notes");
      await mkdir(changeRoot, { recursive: true });
      await writeFile(join(changeRoot, "explore.md"), "findings\n", "utf8");
      // A provenance sidecar recorded against a fingerprint that will
      // never match the current worktree -- deterministically "stale"
      // without needing to actually mutate the worktree in between.
      await writeFile(
        join(changeRoot, ".ce-provenance-explore.yml"),
        'commit: "0000000000000000000000000000000000000000"\nfingerprint: "deadbeefdead"\nrecordedAt: "2026-01-01"\n',
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Needs attention:/);
      expect(output).toMatch(/\/explore's findings are stale/);
      expect(output).toMatch(/Next step:\s+\/explore\s*$/m);
    });

    it("suggests /apply while tasks remain, showing numeric progress", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const changeRoot = join(root, "openspec", "changes", "add-contact-notes");
      await mkdir(changeRoot, { recursive: true });
      await writeFile(join(changeRoot, "proposal.md"), "why\n", "utf8");
      await writeFile(
        join(changeRoot, "tasks.md"),
        "- [x] Task one\n- [x] Task two\n- [ ] Task three\n",
        "utf8",
      );
      await writeFreshProvenance(changeRoot, "propose");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Progress:.*tasks 2\/3/);
      expect(output).toMatch(/Next step:\s+\/apply/);
      expect(output).not.toMatch(/Needs attention:/);
    });

    it("suggests /verify once every task is checked and no verify report exists yet", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const changeRoot = join(root, "openspec", "changes", "add-contact-notes");
      await mkdir(changeRoot, { recursive: true });
      await writeFile(join(changeRoot, "proposal.md"), "why\n", "utf8");
      await writeFile(join(changeRoot, "tasks.md"), "- [x] Task one\n", "utf8");
      await writeFreshProvenance(changeRoot, "propose");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Next step:\s+\/verify/);
    });

    it("flags a FAIL verify report as attention and suggests fixing before re-verifying", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const changeRoot = join(root, "openspec", "changes", "add-contact-notes");
      await mkdir(join(changeRoot, "reports"), { recursive: true });
      await writeFile(join(changeRoot, "proposal.md"), "why\n", "utf8");
      await writeFile(join(changeRoot, "tasks.md"), "- [x] Task one\n", "utf8");
      await writeFreshProvenance(changeRoot, "propose");
      await writeFile(
        join(changeRoot, "reports", "2026-06-01-verify.md"),
        "# Verify\n\n**Verdict:** FAIL\n",
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Needs attention:/);
      expect(output).toMatch(/last \/verify was FAIL/);
      expect(output).toMatch(/Next step:\s+\/apply \(fix findings\), then \/verify/);
    });

    it("suggests /archive once both /verify and /adversarial-review are a clean PASS", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      const changeRoot = join(root, "openspec", "changes", "add-contact-notes");
      await mkdir(join(changeRoot, "reports"), { recursive: true });
      await writeFile(join(changeRoot, "proposal.md"), "why\n", "utf8");
      await writeFile(join(changeRoot, "tasks.md"), "- [x] Task one\n", "utf8");
      await writeFreshProvenance(changeRoot, "propose");
      await writeFile(
        join(changeRoot, "reports", "2026-06-01-verify.md"),
        "# Verify\n\n**Verdict:** PASS\n",
        "utf8",
      );
      await writeFile(
        join(changeRoot, "reports", "2026-06-02-adversarial-review.md"),
        "# Adversarial Review\n\n**Verdict:** PASS\n",
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Next step:\s+\/archive/);
      expect(output).not.toMatch(/Needs attention:/);
    });

    it("shows a compact multi-change notice, never a full per-change breakdown, when more than one active change exists", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const root = await trustedRoot();
      await mkdir(join(root, "openspec", "changes", "alpha-change"), { recursive: true });
      await mkdir(join(root, "openspec", "changes", "beta-change"), { recursive: true });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active changes:\s+alpha-change, beta-change/);
      expect(output).toMatch(/ce open --change <name>/);
    });

    it("reports repository-bootstrap needs as attention, with the exact commands still shown", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace, writeWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const project = basenameOf(repoDir);
      const workspace = await readWorkspace(project, "issue-1");
      await writeWorkspace({
        ...workspace,
        bootstrap: {
          required: true,
          findings: [
            {
              ecosystem: "node",
              manifest: "package.json",
              message: "node_modules/ is missing",
              suggestedCommand: "npm install",
            },
          ],
        },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Needs attention:/);
      expect(output).toMatch(/This repository needs local setup/);
      expect(output).toMatch(/Local setup needed:/);
      expect(output).toMatch(/node_modules\/ is missing/);
      expect(output).toMatch(/Run: npm install/);
    });

    describe("Existing PR review workspace", () => {
      it("suggests /adversarial-review when no review report exists yet", async () => {
        const { startCommand } = await import("../../src/commands/start.js");
        const { statusCommand } = await import("../../src/commands/status.js");
        const { execa } = await import("execa");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const base = await execa("git", ["-C", repoDir, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
        await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
        await execa("git", ["-C", repoDir, "add", "."]);
        await execa("git", ["-C", repoDir, "commit", "-m", "feature"]);
        const head = await execa("git", ["-C", repoDir, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());

        await startCommand({ repo: repoDir, issue: "review-1", base, head });

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        await statusCommand();

        const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
        expect(output).toMatch(/Type:\s+Existing PR review/);
        expect(output).toMatch(/Review:\s+not yet done/);
        expect(output).toMatch(/Next step:\s+\/adversarial-review/);
      });

      it("reports a clean review PASS as complete", async () => {
        const { startCommand } = await import("../../src/commands/start.js");
        const { statusCommand } = await import("../../src/commands/status.js");
        const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
          "../../src/core/workspace.js"
        );
        const { execa } = await import("execa");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const base = await execa("git", ["-C", repoDir, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
        await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
        await execa("git", ["-C", repoDir, "add", "."]);
        await execa("git", ["-C", repoDir, "commit", "-m", "feature"]);
        const head = await execa("git", ["-C", repoDir, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());

        await startCommand({ repo: repoDir, issue: "review-1", base, head });

        const pointer = await readActivePointer();
        const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
        const trusted = resolveTrustedOpenSpec(workspace)!;
        await mkdir(join(trusted.root, "reviews"), { recursive: true });
        await writeFile(
          join(trusted.root, "reviews", "2026-06-01-adversarial-review.md"),
          "# Adversarial Review\n\n**Verdict:** PASS\n",
          "utf8",
        );

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        await statusCommand();

        const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
        expect(output).toMatch(/Review:\s+done -- verdict PASS/);
        expect(output).toMatch(/Next step:\s+none -- review complete/);
      });
    });

    describe("Existing PR review workspace: stale detection (live gh check)", () => {
      let remoteDir: string;

      beforeEach(async () => {
        const { execa } = await import("execa");
        remoteDir = await mkdtemp(join(tmpdir(), "ce-harness-remote-"));
        await execa("git", ["clone", "--bare", repoDir, remoteDir]);
        await execa("git", ["-C", repoDir, "remote", "add", "origin", remoteDir]);
        const { setupFakeGh } = await import("../helpers/fakeGh.js");
        setupFakeGh();
      });

      afterEach(async () => {
        const { teardownFakeGh } = await import("../helpers/fakeGh.js");
        teardownFakeGh();
        await rm(remoteDir, { recursive: true, force: true });
      });

      /** Same-repo PR setup, mirroring review.test.ts's helper of the same shape. */
      async function setupSameRepoPr(prNumber: number, branchName = `feature-${prNumber}`) {
        const { execa } = await import("execa");
        const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
        await execa("git", ["-C", repoDir, "checkout", "-b", branchName]);
        await writeFile(join(repoDir, `${branchName}.txt`), "change\n", "utf8");
        await execa("git", ["-C", repoDir, "add", "."]);
        await execa("git", ["-C", repoDir, "commit", "-m", `${branchName} commit`]);
        const headSha = (await execa("git", ["-C", repoDir, "rev-parse", branchName])).stdout.trim();
        await execa("git", ["-C", repoDir, "push", "origin", `${branchName}:refs/heads/${branchName}`]);
        await execa("git", ["-C", repoDir, "push", "origin", `${branchName}:refs/pull/${prNumber}/head`]);
        await execa("git", ["-C", repoDir, "checkout", "main"]);
        return { baseSha, headSha, baseRefName: "main", headRefName: branchName };
      }

      async function pushFollowupCommit(prNumber: number, branchName: string): Promise<string> {
        const { execa } = await import("execa");
        await execa("git", ["-C", repoDir, "checkout", branchName]);
        await writeFile(join(repoDir, `${branchName}-followup.txt`), "followup\n", "utf8");
        await execa("git", ["-C", repoDir, "add", "."]);
        await execa("git", ["-C", repoDir, "commit", "-m", "followup"]);
        const headSha = (await execa("git", ["-C", repoDir, "rev-parse", branchName])).stdout.trim();
        await execa("git", ["-C", repoDir, "push", "origin", `${branchName}:refs/heads/${branchName}`]);
        await execa("git", ["-C", repoDir, "push", "origin", `${branchName}:refs/pull/${prNumber}/head`]);
        await execa("git", ["-C", repoDir, "checkout", "main"]);
        return headSha;
      }

      it("reports stale when the PR has new commits since the last completed review", async () => {
        const { reviewCommand } = await import("../../src/commands/review.js");
        const { statusCommand } = await import("../../src/commands/status.js");
        const { readWorkspace, resolveTrustedOpenSpec, readActivePointer } = await import(
          "../../src/core/workspace.js"
        );
        const { setFakePrSnapshot } = await import("../helpers/fakeGh.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(400);
        setFakePrSnapshot({
          number: 400,
          title: "t",
          baseRefName,
          baseRefOid: baseSha,
          headRefName,
          headRefOid: headSha,
          isCrossRepository: false,
        });
        await reviewCommand({ repo: repoDir, prNumber: "400" });

        const pointer = await readActivePointer();
        const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
        const trusted = resolveTrustedOpenSpec(workspace)!;
        await mkdir(join(trusted.root, "reviews"), { recursive: true });
        await writeFile(
          join(trusted.root, "reviews", `2026-06-01-pr-400-adversarial-review.md`),
          `# Adversarial Review\n\n**Verdict:** PASS WITH GAPS\n**Reviewed PR head:** ${headSha}\n`,
          "utf8",
        );

        // The PR author pushes a new commit -- gh now reports a different
        // head than the one the report above covered.
        const newHeadSha = await pushFollowupCommit(400, headRefName);
        setFakePrSnapshot({
          number: 400,
          title: "t",
          baseRefName,
          baseRefOid: baseSha,
          headRefName,
          headRefOid: newHeadSha,
          isCrossRepository: false,
        });

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        await statusCommand();

        const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
        expect(output).toMatch(/Review:\s+stale -- PR updated since last review/);
        expect(output).toMatch(/Previous verdict:\s+PASS WITH GAPS/);
        expect(output).toMatch(new RegExp(`Reviewed HEAD:\\s+${headSha}`));
        expect(output).toMatch(new RegExp(`Current HEAD:\\s+${newHeadSha}`));
        expect(output).toMatch(/Next step:\s+follow-up review/);
      });

      it("reports the review as done, with no staleness claim, when the PR head matches what was reviewed", async () => {
        const { reviewCommand } = await import("../../src/commands/review.js");
        const { statusCommand } = await import("../../src/commands/status.js");
        const { readWorkspace, resolveTrustedOpenSpec, readActivePointer } = await import(
          "../../src/core/workspace.js"
        );
        const { setFakePrSnapshot } = await import("../helpers/fakeGh.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(401);
        setFakePrSnapshot({
          number: 401,
          title: "t",
          baseRefName,
          baseRefOid: baseSha,
          headRefName,
          headRefOid: headSha,
          isCrossRepository: false,
        });
        await reviewCommand({ repo: repoDir, prNumber: "401" });

        const pointer = await readActivePointer();
        const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
        const trusted = resolveTrustedOpenSpec(workspace)!;
        await mkdir(join(trusted.root, "reviews"), { recursive: true });
        await writeFile(
          join(trusted.root, "reviews", `2026-06-01-pr-401-adversarial-review.md`),
          `# Adversarial Review\n\n**Verdict:** PASS\n**Reviewed PR head:** ${headSha}\n`,
          "utf8",
        );

        // gh still reports the exact same head -- nothing has changed.
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        await statusCommand();

        const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
        expect(output).toMatch(/Review:\s+done -- verdict PASS/);
        expect(output).not.toMatch(/stale/);
        expect(output).toMatch(/Next step:\s+none -- review complete/);
      });

      it("degrades to the existing, non-live behavior when gh is unavailable -- never fails ce status", async () => {
        const { reviewCommand } = await import("../../src/commands/review.js");
        const { statusCommand } = await import("../../src/commands/status.js");
        const { readWorkspace, resolveTrustedOpenSpec, readActivePointer } = await import(
          "../../src/core/workspace.js"
        );
        const { setFakePrSnapshot } = await import("../helpers/fakeGh.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(402);
        setFakePrSnapshot({
          number: 402,
          title: "t",
          baseRefName,
          baseRefOid: baseSha,
          headRefName,
          headRefOid: headSha,
          isCrossRepository: false,
        });
        await reviewCommand({ repo: repoDir, prNumber: "402" });

        const pointer = await readActivePointer();
        const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
        const trusted = resolveTrustedOpenSpec(workspace)!;
        await mkdir(join(trusted.root, "reviews"), { recursive: true });
        await writeFile(
          join(trusted.root, "reviews", `2026-06-01-pr-402-adversarial-review.md`),
          `# Adversarial Review\n\n**Verdict:** PASS WITH GAPS\n**Reviewed PR head:** ${headSha}\n`,
          "utf8",
        );

        // gh becomes unavailable after the workspace was already created.
        const { nonExistentGhBin } = await import("../helpers/fakeGh.js");
        const dir = await mkdtemp(join(tmpdir(), "ce-harness-nogh-"));
        process.env.CE_GH_BIN = nonExistentGhBin(dir);
        try {
          const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
          await expect(statusCommand()).resolves.not.toThrow();

          const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
          expect(output).toMatch(/Review:\s+done -- verdict PASS WITH GAPS/);
          expect(output).not.toMatch(/stale/);
          expect(output).not.toMatch(/Current HEAD:/);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });

      it("legacy report with no Reviewed PR head field: falls back to the workspace's configured head, and still detects staleness", async () => {
        const { reviewCommand } = await import("../../src/commands/review.js");
        const { statusCommand } = await import("../../src/commands/status.js");
        const { readWorkspace, resolveTrustedOpenSpec, readActivePointer } = await import(
          "../../src/core/workspace.js"
        );
        const { setFakePrSnapshot } = await import("../helpers/fakeGh.js");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(403);
        setFakePrSnapshot({
          number: 403,
          title: "t",
          baseRefName,
          baseRefOid: baseSha,
          headRefName,
          headRefOid: headSha,
          isCrossRepository: false,
        });
        await reviewCommand({ repo: repoDir, prNumber: "403" });

        const pointer = await readActivePointer();
        const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
        const trusted = resolveTrustedOpenSpec(workspace)!;
        await mkdir(join(trusted.root, "reviews"), { recursive: true });
        // A legacy-shaped report: no PR-scoped filename, no "Reviewed PR
        // head" field -- exactly what a report written before this
        // feature shipped looks like.
        await writeFile(
          join(trusted.root, "reviews", "2026-05-01-adversarial-review.md"),
          "# Adversarial Review\n\n**Verdict:** PASS WITH GAPS\n",
          "utf8",
        );

        const newHeadSha = await pushFollowupCommit(403, headRefName);
        setFakePrSnapshot({
          number: 403,
          title: "t",
          baseRefName,
          baseRefOid: baseSha,
          headRefName,
          headRefOid: newHeadSha,
          isCrossRepository: false,
        });

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        await statusCommand();

        const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
        expect(output).toMatch(/Review:\s+stale -- PR updated since last review/);
        expect(output).toMatch(new RegExp(`Reviewed HEAD:\\s+${headSha}`));
        expect(output).toMatch(/inferred/);
      });

      it("a plain ce start --base --head workspace (never went through ce review) never attempts a live check", async () => {
        const { startCommand } = await import("../../src/commands/start.js");
        const { statusCommand } = await import("../../src/commands/status.js");
        const { execa } = await import("execa");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const base = await execa("git", ["-C", repoDir, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
        await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
        await execa("git", ["-C", repoDir, "add", "."]);
        await execa("git", ["-C", repoDir, "commit", "-m", "feature"]);
        const head = await execa("git", ["-C", repoDir, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());

        await startCommand({ repo: repoDir, issue: "review-1", base, head });

        const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
          "../../src/core/workspace.js"
        );
        const pointer = await readActivePointer();
        const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
        const trusted = resolveTrustedOpenSpec(workspace)!;
        await mkdir(join(trusted.root, "reviews"), { recursive: true });
        await writeFile(
          join(trusted.root, "reviews", "2026-06-01-adversarial-review.md"),
          "# Adversarial Review\n\n**Verdict:** PASS\n",
          "utf8",
        );

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        await statusCommand();

        const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
        expect(output).toMatch(/Review:\s+done -- verdict PASS/);
        expect(output).not.toMatch(/stale/);
        expect(output).not.toMatch(/Current HEAD:/);
      });
    });
  });

  describe("ce status --all", () => {
    it("reports nothing to show when no workspace or project has ever existed", async () => {
      const { statusCommand } = await import("../../src/commands/status.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await statusCommand({ all: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/no projects or workspaces yet/i);
    });

    it("refuses when combined with an explicit [workspace] selector", async () => {
      const { statusCommand } = await import("../../src/commands/status.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await expect(statusCommand({ all: true, workspace: "foo/bar" })).rejects.toThrow(CeError);
      await expect(statusCommand({ all: true, workspace: "foo/bar" })).rejects.toThrow(
        /cannot be combined with a specific workspace/,
      );
    });

    it("shows a project with its preserved workspace, marking the default", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ all: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/ce-harness knows about 1 project\(s\)/);
      expect(output).toMatch(/Workspaces:\s+issue-1 \(default\)/);
      expect(output).toMatch(/Active changes:\s+\(none\)/);
      expect(output).toMatch(/Archived:\s+\(none\)/);
      expect(output).toMatch(/Reviews:\s+\(none\)/);
      // Never dumps the raw store path/id.
      expect(output).not.toMatch(/\.ce-harness\/openspec/);
    });

    it("shows an active change's compact progress line", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
        "../../src/core/workspace.js"
      );
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace)!;
      const changeRoot = join(trusted.root, "openspec", "changes", "add-contact-notes");
      await mkdir(changeRoot, { recursive: true });
      await writeFile(join(changeRoot, "explore.md"), "findings\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ all: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+add-contact-notes\s+\(explore ✓/);
    });

    it("still shows a project's durable history (archived changes) after its only workspace is cleaned up -- proving this is not merely a workspace-directory listing", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
        "../../src/core/workspace.js"
      );
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace)!;
      await mkdir(join(trusted.root, "openspec", "changes", "archive", "2026-05-01-old-change"), {
        recursive: true,
      });

      await cleanupCommand({ force: true });
      const { listWorkspaces } = await import("../../src/core/workspace.js");
      expect(await listWorkspaces()).toEqual([]);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ all: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/ce-harness knows about 1 project\(s\)/);
      expect(output).toMatch(/Workspaces:\s+\(none currently preserved\)/);
      expect(output).toMatch(/Archived:\s+1 change\(s\)/);
      expect(output).toMatch(/^\s+old-change\s*$/m);
    });

    it("shows the original issue identifier alongside an archived change, from its persisted .ce-workspace.yml ownership sidecar -- never inferred from the change's own name", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
        "../../src/core/workspace.js"
      );
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "138" });
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace)!;
      const archiveDir = join(trusted.root, "openspec", "changes", "archive", "2026-05-01-consolidate-drawer-base-component");
      await mkdir(archiveDir, { recursive: true });
      // The exact sidecar `/propose` writes and `/archive` carries along
      // unchanged into `archive/` -- see core/activeChange.ts's
      // CHANGE_OWNERSHIP_FILENAME.
      await writeFile(
        join(archiveDir, ".ce-workspace.yml"),
        `project: ${workspace.project}\nissue: "138"\n`,
        "utf8",
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ all: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/^\s+138\s+consolidate-drawer-base-component\s*$/m);
    });

    it("shows multiple archived changes each with their own issue identifier, most recent first, and a change with no ownership sidecar shows its name alone -- never a guessed identifier", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
        "../../src/core/workspace.js"
      );
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const pointer = await readActivePointer();
      const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace)!;
      const archiveRoot = join(trusted.root, "openspec", "changes", "archive");

      const dir130 = join(archiveRoot, "2026-08-01-contacts-email-notes");
      await mkdir(dir130, { recursive: true });
      await writeFile(join(dir130, ".ce-workspace.yml"), `project: ${workspace.project}\nissue: "130"\n`, "utf8");

      const dir143 = join(archiveRoot, "2026-08-15-document-dashboard-patterns");
      await mkdir(dir143, { recursive: true });
      await writeFile(join(dir143, ".ce-workspace.yml"), `project: ${workspace.project}\nissue: "143"\n`, "utf8");

      // Predates the ownership-sidecar mechanism -- no identifier to show.
      await mkdir(join(archiveRoot, "2026-08-20-legacy-cleanup"), { recursive: true });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand({ all: true });

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Archived:\s+3 change\(s\)/);
      const lines = output.split("\n").map((l) => l.trim());
      const legacyIndex = lines.indexOf("legacy-cleanup");
      const line143 = lines.indexOf("143  document-dashboard-patterns");
      const line130 = lines.indexOf("130  contacts-email-notes");
      expect(legacyIndex).toBeGreaterThanOrEqual(0);
      expect(line143).toBeGreaterThanOrEqual(0);
      expect(line130).toBeGreaterThanOrEqual(0);
      // Most-recently-archived first: legacy-cleanup (08-20), then 143 (08-15), then 130 (08-01).
      expect(legacyIndex).toBeLessThan(line143);
      expect(line143).toBeLessThan(line130);
    });

    it("shows multiple projects, sorted", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const otherRepo = await createTempRepo();
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      try {
        await startCommand({ repo: repoDir, issue: "issue-1" });
        await startCommand({ repo: otherRepo, issue: "issue-2" });

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        await statusCommand({ all: true });

        const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
        expect(output).toMatch(/ce-harness knows about 2 project\(s\)/);
      } finally {
        await rm(otherRepo, { recursive: true, force: true });
      }
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
