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

describe("ce status (integration)", () => {
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

    await statusCommand();

    expect(logSpy).toHaveBeenCalledWith("No active workspace.");
  });

  it("reports full details for the active workspace, including a clean worktree", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { statusCommand } = await import("../../src/commands/status.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await statusCommand();

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
    await statusCommand();

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
      await expect(statusCommand()).resolves.toBeUndefined();

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

      await expect(statusCommand()).resolves.toBeUndefined();
    });

    it("a normal, still-registered worktree is unaffected by this check", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await expect(statusCommand()).resolves.toBeUndefined();

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
      await statusCommand();

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
      await statusCommand();

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
      await expect(statusCommand()).resolves.toBeUndefined();

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
      await statusCommand();

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
      await expect(statusCommand()).resolves.toBeUndefined();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

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
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/explore fresh \(as of 2026-09-01\)/);
      expect(output).toMatch(/propose stale \(repo changed since 2026-08-15\)/);
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
      await statusCommand({ workspace: `${project}/issue-130` });
      let output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+fix-contact-empty-state/);
      expect(output).not.toMatch(/add-billing-export/);

      logSpy.mockClear();
      await statusCommand({ workspace: `${project}/issue-143` });
      output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/Active change:\s+add-billing-export/);
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

      await statusCommand({ workspace: `${project}/issue-130` });

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
      await statusCommand();

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
      await statusCommand({ workspace: `${project}/issue-130` });

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
      await statusCommand({ workspace: `${project}/issue-130` });

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
      await statusCommand({ workspace: `${project}/issue-130` });

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
      await statusCommand();

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
      await statusCommand();

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

      await expect(statusCommand({ workspace: `${project}/no-such-issue` })).rejects.toThrow(CeError);
      await expect(statusCommand({ workspace: `${project}/no-such-issue` })).rejects.toThrow(
        /No workspace found for/,
      );
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
