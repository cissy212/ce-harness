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
        CE_LENSES_DIR: join(workspace.workspacePath, "lenses"),
        OPENCODE_CONFIG_DIR: join(workspace.workspacePath, "opencode"),
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
      expect(content).toMatch(/4\. \*\*Assess delta spec sync state\*\*/);
      expect(content).toMatch(/5\. \*\*Perform the archive\*\*/);
      expect(content).toMatch(/6\. \*\*Display summary\*\*/);
      expect(content).toMatch(/If any artifacts are not `done`:/);
      expect(content).toMatch(/If incomplete tasks found:/);
      expect(content).toMatch(/Sync now \(recommended\)/);
      expect(content).toMatch(/Archive without syncing/);
      expect(content).toMatch(/## Archive Complete/);
      expect(content).toMatch(/## Archive Complete \(with warnings\)/);
      expect(content).toMatch(/## Archive Failed/);
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
      expect(content).not.toMatch(/docker compose/i);
      // "Prisma" legitimately appears only as an example of a stack this
      // command must NOT assume (per requirement 7's own wording); it must
      // never appear as an actual invoked command (e.g. "npx prisma ...").
      expect(content).not.toMatch(/npx prisma/i);
      expect(content).not.toMatch(/prisma migrate/i);
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

      it("asks the user when multiple lenses match equally, and always allows explicit override", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/match equally well.*ask the user/i);
        expect(normalized).toMatch(/always allow an? explicit user override/i);
      });

      it('continues normally and reports "Lens applied: None" when nothing clearly matches', async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).toMatch(/continue normally/i);
        expect(content).toContain("Lens applied: None");
        expect(content).toMatch(/this is not a failure/i);
      });

      it("loads a selected lens as an ordinary reasoning input, never a subagent or delegated conversation", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).toMatch(/load its file as an ordinary reasoning input/i);
        expect(content).toMatch(/do not spawn a subagent/i);
      });

      it("includes a '## Lens Coverage' report section with all four required fields", async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).toMatch(/## Lens Coverage/);
        expect(content).toMatch(/\*\*Lens applied:\*\*/);
        expect(content).toMatch(/\*\*Selection rationale:\*\*/);
        expect(content).toMatch(/\*\*Other lenses considered:\*\*/);
        expect(content).toMatch(/\*\*Lens checks applied:\*\*/);
      });

      it('never uses "specialist" terminology anywhere in the operational body', async () => {
        const { readFile } = await import("node:fs/promises");
        const { templatesRoot } = await import("../../src/core/templates.js");
        const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");

        expect(content).not.toMatch(/specialist/i);
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

    it("requires evidence, impact, area, and confidence for every finding, with a dedicated findings table", async () => {
      const content = await readTemplate();

      expect(content).toMatch(
        /\| Severity \| Area \| Confidence \| Affected Requirement\/Design\/Task \| Finding \| Evidence \| Impact \| Recommended Fix \|/,
      );
      expect(content).toMatch(/never invent a finding you don't have evidence for/i);
      expect(content).toMatch(
        /state the affected\s*requirement\/design decision\/task, its impact, its\s*Area, its Confidence, and a recommended fix/i,
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

      it("asks the user when multiple lenses match equally, and always allows explicit override", async () => {
        const content = await readTemplate();
        const normalized = content.replace(/\s+/g, " ");

        expect(normalized).toMatch(/match equally well.*ask the user/i);
        expect(normalized).toMatch(/always allow an? explicit user override/i);
      });

      it('continues normally and reports "Lens applied: None" when nothing clearly matches', async () => {
        const content = await readTemplate();

        expect(content).toMatch(/continue normally/i);
        expect(content).toContain("Lens applied: None");
        expect(content).toMatch(/this is not a failure/i);
      });

      it("loads a selected lens as an ordinary reasoning input, never a subagent or delegated conversation", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/load its file as an ordinary reasoning input/i);
        expect(content).toMatch(/do not spawn a subagent/i);
      });

      it("includes a '## Lens Coverage' report section with all four required fields", async () => {
        const content = await readTemplate();

        expect(content).toMatch(/## Lens Coverage/);
        expect(content).toMatch(/\*\*Lens applied:\*\*/);
        expect(content).toMatch(/\*\*Selection rationale:\*\*/);
        expect(content).toMatch(/\*\*Other lenses considered:\*\*/);
        expect(content).toMatch(/\*\*Lens checks applied:\*\*/);
      });

      it('never uses "specialist" terminology anywhere in the operational body', async () => {
        const content = await readTemplate();

        expect(content).not.toMatch(/specialist/i);
      });
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
