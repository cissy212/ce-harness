import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
  setupFakeClaude,
  teardownFakeClaude,
  nonExistentClaudeBin,
  type FakeClaudeEnv,
} from "../helpers/fakeClaude.js";

describe("Claude Code runner (core/runners/claude.ts)", () => {
  describe("binary resolution", () => {
    const originalBin = process.env.CE_CLAUDE_BIN;

    afterEach(() => {
      if (originalBin === undefined) delete process.env.CE_CLAUDE_BIN;
      else process.env.CE_CLAUDE_BIN = originalBin;
    });

    it('defaults to "claude"', async () => {
      delete process.env.CE_CLAUDE_BIN;
      const { claudeBinary } = await import("../../src/core/runners/claude.js");
      expect(claudeBinary()).toBe("claude");
    });

    it("CE_CLAUDE_BIN overrides the resolved binary", async () => {
      process.env.CE_CLAUDE_BIN = "/custom/path/to/claude";
      const { claudeBinary } = await import("../../src/core/runners/claude.js");
      expect(claudeBinary()).toBe("/custom/path/to/claude");
    });
  });

  describe("launch", () => {
    let fakeClaude: FakeClaudeEnv;
    let worktreePath: string;

    beforeEach(async () => {
      fakeClaude = await setupFakeClaude();
      worktreePath = await mkdtemp(join(tmpdir(), "ce-harness-claude-launch-"));
    });

    afterEach(async () => {
      await teardownFakeClaude(fakeClaude);
      await rm(worktreePath, { recursive: true, force: true });
    });

    it("launches with the given cwd and env, no arguments (interactive handoff)", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      const result = await CLAUDE_RUNNER.launch({
        cwd: worktreePath,
        env: { CE_WORKSPACE: "/tmp/some-workspace" },
      });

      expect(result).toEqual({ launched: true, exitCode: 0 });
      const launch = JSON.parse(await readFile(fakeClaude.outputFile, "utf8"));
      expect(launch.cwd).toBe(await realpathOf(worktreePath));
      expect(launch.argv).toEqual([]);
      expect(launch.env.CE_WORKSPACE).toBe("/tmp/some-workspace");
    });

    it("uses the CE_CLAUDE_BIN override for the actual spawned binary", async () => {
      // setupFakeClaude already points CE_CLAUDE_BIN at the fake binary --
      // a successful launch (rather than ENOENT) is itself proof the
      // override took effect over the "claude" default.
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const result = await CLAUDE_RUNNER.launch({ cwd: worktreePath, env: {} });
      expect(result.launched).toBe(true);
    });

    it("reports launch failure without throwing when the binary cannot be found", async () => {
      process.env.CE_CLAUDE_BIN = nonExistentClaudeBin(fakeClaude.dir);
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      const result = await CLAUDE_RUNNER.launch({ cwd: worktreePath, env: {} });
      expect(result.launched).toBe(false);
    });

    it("propagates the fake claude's exit code", async () => {
      process.env.FAKE_CLAUDE_EXIT_CODE = "5";
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const result = await CLAUDE_RUNNER.launch({ cwd: worktreePath, env: {} });
      expect(result).toEqual({ launched: true, exitCode: 5 });
    });

    it("formatLaunchCommand renders cwd, env assignments, and the resolved binary", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const command = CLAUDE_RUNNER.formatLaunchCommand("/tmp/wt", { CE_WORKSPACE: "/tmp/ws" });
      expect(command).toContain('cd "/tmp/wt"');
      expect(command).toContain('CE_WORKSPACE="/tmp/ws"');
      expect(command.trim().endsWith(process.env.CE_CLAUDE_BIN as string)).toBe(true);
    });
  });

  describe("writeConfig", () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await createTempRepo();
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it("materializes <worktree>/.claude/{commands,skills} from the canonical templates, and returns true", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { templatesRoot } = await import("../../src/core/templates.js");

      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });
      expect(written).toBe(true);

      const claudeDir = join(repoDir, ".claude");
      expect(existsSync(join(claudeDir, "commands", "workspace.md"))).toBe(true);
      expect(existsSync(join(claudeDir, "skills", "openspec-sync-specs", "SKILL.md"))).toBe(true);

      const copied = await readFile(join(claudeDir, "commands", "workspace.md"), "utf8");
      const source = await readFile(join(templatesRoot(), "commands", "workspace.md"), "utf8");
      expect(copied).toBe(source);
    });

    it("adds /.claude to the repository's local, never-committed exclude file", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      await CLAUDE_RUNNER.writeConfig({ workspacePath: "/tmp/unused-workspace", worktreePath: repoDir });

      const excludeContent = await readFile(join(repoDir, ".git", "info", "exclude"), "utf8");
      expect(excludeContent).toContain("/.claude");

      const { execa } = await import("execa");
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });

    it('never overwrites a pre-existing, UNTRACKED ".claude/" directory, and returns false', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      // Deliberately never `git add`/`git commit`ed -- this is untracked,
      // local-only content (e.g. the user's own personal Claude Code
      // settings), the exact case the existence check must catch even
      // though Git itself has no record of this path at all.
      const preExistingDir = join(repoDir, ".claude", "commands");
      await mkdir(preExistingDir, { recursive: true });
      await writeFile(join(preExistingDir, "custom.md"), "the user's own untracked command\n", "utf8");

      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });
      expect(written).toBe(false);

      // Untouched: no workspace.md was copied in, and the pre-existing
      // file survives exactly as it was. Never added to the local
      // exclude file either -- it was never harness-written, so it must
      // keep showing up as a real untracked change in `git status`.
      expect(existsSync(join(repoDir, ".claude", "commands", "workspace.md"))).toBe(false);
      expect(await readFile(join(preExistingDir, "custom.md"), "utf8")).toBe(
        "the user's own untracked command\n",
      );
      const { execa } = await import("execa");
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toContain(".claude/");
      const excludeContent = existsSync(join(repoDir, ".git", "info", "exclude"))
        ? await readFile(join(repoDir, ".git", "info", "exclude"), "utf8")
        : "";
      expect(excludeContent).not.toContain("/.claude");
    });

    it('never overwrites a pre-existing, TRACKED ".claude/" directory (committed by the repository itself), and returns false', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      const trackedDir = join(repoDir, ".claude", "commands");
      await mkdir(trackedDir, { recursive: true });
      await writeFile(join(trackedDir, "custom.md"), "the repository's own tracked command\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .claude directory"]);

      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });
      expect(written).toBe(false);

      expect(existsSync(join(repoDir, ".claude", "commands", "workspace.md"))).toBe(false);
      expect(await readFile(join(trackedDir, "custom.md"), "utf8")).toBe(
        "the repository's own tracked command\n",
      );
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });
  });

  describe("writeCodeGraphConfig", () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await createTempRepo();
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it("writes <worktree>/.mcp.json registering CodeGraph's MCP server, excludes it locally, and returns true", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      const written = await CLAUDE_RUNNER.writeCodeGraphConfig(
        { workspacePath: "/tmp/unused-workspace", worktreePath: repoDir },
        "codegraph",
      );
      expect(written).toBe(true);

      const configPath = join(repoDir, ".mcp.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      expect(config.mcpServers.codegraph.command).toBe("codegraph");
      expect(config.mcpServers.codegraph.args).toEqual(["serve", "--mcp", "--path", repoDir]);

      const excludeContent = await readFile(join(repoDir, ".git", "info", "exclude"), "utf8");
      expect(excludeContent).toContain("/.mcp.json");
    });

    it('never overwrites a pre-existing, UNTRACKED ".mcp.json", and returns false', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      // Never `git add`/`git commit`ed -- e.g. a personal, local-only MCP
      // config the user already had sitting in their repo.
      await writeFile(join(repoDir, ".mcp.json"), '{"mcpServers":{"personal":{}}}\n', "utf8");

      const written = await CLAUDE_RUNNER.writeCodeGraphConfig(
        { workspacePath: "/tmp/unused-workspace", worktreePath: repoDir },
        "codegraph",
      );
      expect(written).toBe(false);

      expect(await readFile(join(repoDir, ".mcp.json"), "utf8")).toBe(
        '{"mcpServers":{"personal":{}}}\n',
      );
      const { execa } = await import("execa");
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toContain(".mcp.json");
      const excludeContent = existsSync(join(repoDir, ".git", "info", "exclude"))
        ? await readFile(join(repoDir, ".git", "info", "exclude"), "utf8")
        : "";
      expect(excludeContent).not.toContain("/.mcp.json");
    });

    it('never overwrites a pre-existing, TRACKED ".mcp.json" (committed by the repository itself), and returns false', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      await writeFile(join(repoDir, ".mcp.json"), '{"mcpServers":{"repoOwn":{}}}\n', "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .mcp.json"]);

      const written = await CLAUDE_RUNNER.writeCodeGraphConfig(
        { workspacePath: "/tmp/unused-workspace", worktreePath: repoDir },
        "codegraph",
      );
      expect(written).toBe(false);

      expect(await readFile(join(repoDir, ".mcp.json"), "utf8")).toBe(
        '{"mcpServers":{"repoOwn":{}}}\n',
      );
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });
  });

  describe("buildEnv", () => {
    it("returns no runner-specific env vars -- Claude discovers .claude/.mcp.json from cwd alone", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const workspace = baseWorkspace();

      expect(CLAUDE_RUNNER.buildEnv(workspace)).toEqual({});
    });
  });

  describe("managedWorktreeRelativePaths", () => {
    it("returns [] when runnerWorktreeArtifacts is absent (legacy workspace, or nothing was written)", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(baseWorkspace())).toEqual([]);
    });

    it("returns [\".claude\"] when only commandsManaged is true", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const workspace = baseWorkspace({ runnerWorktreeArtifacts: { commandsManaged: true } });
      expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([".claude"]);
    });

    it('returns [".claude", ".mcp.json"] when both are managed', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const workspace = baseWorkspace({
        runnerWorktreeArtifacts: { commandsManaged: true, mcpManaged: true },
      });
      expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([".claude", ".mcp.json"]);
    });

    it("never includes a path whose flag is false -- a pre-existing, safely-skipped path is never claimed", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const workspace = baseWorkspace({
        runnerWorktreeArtifacts: { commandsManaged: false, mcpManaged: false },
      });
      expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([]);
    });
  });
});

function baseWorkspace(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project: "demo",
    repositoryPath: "/tmp/demo-repo",
    issue: "issue-1",
    sanitizedIssue: "issue-1",
    baseBranch: "main",
    internalBranch: "ce-harness/issue-1",
    worktreePath: "/tmp/demo-worktree",
    workspacePath: "/tmp/demo-workspace",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
